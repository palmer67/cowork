import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { isExpired } from './claims.ts';
import { gitTry, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { listClaims, stateRoot } from './store.ts';
import {
  listTaskLiveStates,
  taskLiveFile,
  transitionM2Task,
  writeTaskLive,
  type TaskLive,
  type VerificationLive,
} from './taskstore.ts';
import { findDependencyCycle, readTrunkCatalog, type TaskCatalog } from './tasks.ts';
import { listIntents, recoverIntents } from './tasknext.ts';
import { readPidStartedAt } from './taskverify.ts';

export interface TaskDoctorReport {
  /** 仍未解决/需要人看的问题，每条都带文件与怎么修。 */
  problems: string[];
  /** --fix 本次实际修好的项。 */
  fixed: string[];
  /** 可清理但不影响退出码的提示。 */
  notices: string[];
}

const LEASE_STATUSES = new Set(['claimed', 'in_progress']);
const LOCK_TMP_MAX_AGE_MS = 60_000;
const TRASH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UNVERIFIED_NOTICE_MS = 24 * 60 * 60 * 1000;

interface VerificationCandidate {
  id: string;
  task_status: 'verifying' | 'blocked';
  run_id: string;
  pid: number | null;
  host: string | null;
  pid_started_at: string | null;
}

interface RecoveryDecision {
  candidate: VerificationCandidate;
  recover: boolean;
  reason: string;
}

function describeProblem(file: string, issue: string, fix: string): string {
  return `${file}: ${issue}；${fix}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function verificationCandidate(live: TaskLive): VerificationCandidate | null {
  const verification = live.verification;
  if (
    verification === null ||
    (live.status !== 'verifying' && !(live.status === 'blocked' && verification.status === 'running'))
  ) return null;
  return {
    id: live.id,
    task_status: live.status,
    run_id: verification.run_id,
    pid: verification.pid,
    host: verification.host,
    pid_started_at: verification.pid_started_at,
  };
}

async function inspectVerification(candidate: VerificationCandidate): Promise<RecoveryDecision> {
  if (candidate.pid === null) return { candidate, recover: true, reason: '验证进程未启动（pid=null）' };
  if (candidate.host !== hostname()) {
    return { candidate, recover: false, reason: `验证进程 host=${candidate.host ?? '(未知)'}，当前 host=${hostname()}，无法检查` };
  }
  if (candidate.pid === process.pid) {
    return { candidate, recover: true, reason: 'pid 等于 doctor CLI 自身，验证子进程未启动' };
  }
  if (!pidAlive(candidate.pid)) return { candidate, recover: true, reason: `原验证 PID ${candidate.pid} 已不存在` };
  if (candidate.pid_started_at === null) {
    return { candidate, recover: false, reason: `PID ${candidate.pid} 仍存在但 pid_started_at 不可得，拒绝恢复` };
  }
  const current = await readPidStartedAt(candidate.pid);
  if (current.at === null) {
    if (!pidAlive(candidate.pid)) return { candidate, recover: true, reason: `原验证 PID ${candidate.pid} 已不存在` };
    return { candidate, recover: false, reason: `PID ${candidate.pid} 启动时间读取失败（${current.error ?? '未知原因'}），拒绝恢复` };
  }
  if (current.at !== candidate.pid_started_at) {
    return { candidate, recover: true, reason: `PID ${candidate.pid} 已复用（启动时间 ${candidate.pid_started_at} → ${current.at}）` };
  }
  return { candidate, recover: false, reason: `原验证进程仍在运行（pid=${candidate.pid}）` };
}

function recoverVerification(state: string, decision: RecoveryDecision, fixed: string[]): void {
  const { candidate } = decision;
  const live = listTaskLiveStates(state).lives.find((item) => item.id === candidate.id);
  if (
    !decision.recover || live === undefined || live.status !== candidate.task_status ||
    live.verification?.run_id !== candidate.run_id || live.verification.pid !== candidate.pid ||
    live.verification.host !== candidate.host || live.verification.pid_started_at !== candidate.pid_started_at
  ) return;
  const now = new Date().toISOString();
  const verification: VerificationLive = {
    ...live.verification,
    status: 'stale',
    finished_at: now,
    summary: decision.reason,
  };
  const recovery = { at: now, run_id: candidate.run_id, reason: decision.reason };
  if (candidate.task_status === 'blocked') {
    writeTaskLive(state, { ...live, updated_at: now, verification, recovery });
    fixed.push(`已收尾阻塞任务 ${live.id} 的残留验证（${decision.reason}；保留状态与占位）`);
    return;
  }
  transitionM2Task(state, live.id, 'reported_done', {
    agent: live.agent,
    historyAgent: 'doctor',
    note: `doctor --fix recovery: ${decision.reason}`,
    verification,
    recovery,
  });
  fixed.push(`已恢复验证 ${live.id} → reported_done（${decision.reason}；保留 lease/claims）`);
}

function unverifiedNotices(lives: readonly TaskLive[], now = Date.now()): string[] {
  return lives.flatMap((live) => {
    if (live.status !== 'reported_done') return [];
    const report = [...live.history].reverse().find((entry) => entry.to === 'reported_done');
    const at = Date.parse(report?.at ?? live.updated_at);
    if (!Number.isFinite(at) || now - at <= UNVERIFIED_NOTICE_MS) return [];
    return [`${live.id}: reported_done 超过 24 小时，尚未验证；运行 cowork task done ${live.id}`];
  });
}

function leaseProblems(info: RepoInfo, catalog: TaskCatalog, lives: readonly TaskLive[]): string[] {
  const problems: string[] = [];
  for (const live of lives) {
    if (!LEASE_STATUSES.has(live.status)) continue;
    const file = taskLiveFile(stateRoot(info), live.id);
    const spec = catalog.specs.get(live.id);
    if (spec === undefined) {
      problems.push(describeProblem(file, 'lease 指向的任务不在 trunk catalog', '先确认 spec 是否被回滚，再 cowork task cancel'));
      continue;
    }
    if (live.spec_commit !== null) {
      // 只比祖先不够：正常前进后改写同一份 spec，旧 commit 仍是祖先。
      // 直接比 lease 记录那次提交里的 spec blob 与 trunk 现在的内容一致。
      const rel = `.cowork/tasks/${live.id}.md`;
      const atLease = gitTry(['rev-parse', `${live.spec_commit}:${rel}`], info.mainRoot);
      const atTrunk = gitTry(['rev-parse', `${catalog.trunk}:${rel}`], info.mainRoot);
      if (atLease === null || atTrunk === null || atLease !== atTrunk) {
        problems.push(
          describeProblem(
            file,
            `lease 的 spec 内容已漂移（${live.spec_commit.slice(0, 7)} 与 ${catalog.trunk} 上的 ${live.id}.md 不同）`,
            '先 cowork task cancel，再从 trunk 重新 ready',
          ),
        );
      }
    }
  }
  return problems;
}

function specProblems(catalog: TaskCatalog): string[] {
  const problems: string[] = [];
  for (const [id, spec] of catalog.specs) {
    const file = spec.path ?? `${id}.md`;
    if (path.basename(file) !== `${id}.md`) {
      problems.push(describeProblem(file, `文件名与 id 不符（应为 ${id}.md）`, '把文件改名成与 id 一致'));
    }
    if (spec.touches.length === 0) {
      problems.push(describeProblem(file, 'touches 为空', '补 --touches 后重建 spec（ready 前可改）'));
    }
    for (const dep of spec.depends_on) {
      if (!catalog.specs.has(dep)) {
        problems.push(describeProblem(file, `依赖不存在: ${dep}`, '补上依赖 spec，或去掉 --depends'));
      }
    }
    const cycle = findDependencyCycle(spec, catalog.specs);
    if (cycle !== null) {
      problems.push(describeProblem(file, `依赖成环: ${cycle.join(' → ')}`, '删掉环上任意一条 depends_on'));
    }
  }
  for (const diagnostic of catalog.diagnostics) {
    problems.push(describeProblem(diagnostic.file, diagnostic.error, '修好 front-matter 后重新提交'));
  }
  return problems;
}

interface StaleArtifact {
  path: string;
  kind: 'lock.tmp' | 'trash';
}

function staleArtifacts(state: string, now = Date.now()): StaleArtifact[] {
  const found: StaleArtifact[] = [];
  let entries;
  try {
    entries = readdirSync(state, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return found;
    return found;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith('lock.tmp-')) continue;
    const item = path.join(state, entry.name);
    try {
      if (now - lstatSync(item).mtimeMs > LOCK_TMP_MAX_AGE_MS) found.push({ path: item, kind: 'lock.tmp' });
    } catch {
      // Another doctor may remove the item after enumeration.
    }
  }

  let trashEntries;
  try {
    trashEntries = readdirSync(path.join(state, 'trash'), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return found;
    return found;
  }
  for (const entry of trashEntries) {
    const item = path.join(state, 'trash', entry.name);
    try {
      if (now - lstatSync(item).mtimeMs > TRASH_MAX_AGE_MS) found.push({ path: item, kind: 'trash' });
    } catch {
      // Another doctor may remove the item after enumeration.
    }
  }
  return found;
}

/** --fix 的所有写操作；调用方必须在全局锁内执行。 */
function fixPass(info: RepoInfo, state: string, catalog: TaskCatalog, fixed: string[]): void {
  const intents = listIntents(state);
  if (intents.length > 0) {
    const recovery = recoverIntents(state);
    for (const id of [...recovery.recovered, ...recovery.cleaned]) fixed.push(`已回滚未完成事务 ${id}`);
    for (const id of recovery.corrupt) fixed.push(`事务 ${id} 未能回滚（见 doctor 输出）`);
  }

  const states = listTaskLiveStates(state);
  for (const item of states.corrupt) {
    const trashDir = path.join(state, 'trash');
    mkdirSync(trashDir, { recursive: true });
    const target = path.join(trashDir, `task-${item.id}-${Date.now()}.json`);
    try {
      renameSync(item.file, target);
      fixed.push(`已隔离损坏 live ${item.file} → ${target}`);
    } catch {
      // 隔离失败保留原文件，检查阶段仍会报出来。
    }
  }

  const claims = listClaims(state);
  for (const live of states.lives) {
    if (!LEASE_STATUSES.has(live.status)) continue;
    // 只看本任务自己写下的占位：同 agent 跑别的任务时，不能把那条 claim 当成本 lease 的。
    const alive = claims.some(
      (claim) =>
        claim.agentId === live.agent &&
        claim.note === `task ${live.id}` &&
        claim.lane === live.lane &&
        !isExpired(claim, Date.now()),
    );
    if (alive) continue;
    writeTaskLive(state, {
      ...live,
      status: 'ready',
      lane: null,
      lanePath: null,
      agent: null,
      updated_at: new Date().toISOString(),
      history: [
        ...live.history,
        {
          at: new Date().toISOString(),
          from: live.status,
          to: 'ready',
          agent: 'doctor',
          note: 'lease 过期或无对应占位，回收为 ready',
        },
      ],
    });
    fixed.push(`已回收过期 lease ${live.id}（${catalog.trunk}）`);
  }

  for (const artifact of staleArtifacts(state)) {
    try {
      rmSync(artifact.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      fixed.push(`已删除${artifact.kind === 'lock.tmp' ? '锁临时目录' : 'trash 残留'} ${artifact.path}`);
    } catch {
      // Leave failures visible as notices on the follow-up read.
    }
  }
}

/** 只读检查（--fix 时先修再查）。返回 problems 非空即 doctor 退出 1。 */
export async function doctorTasks(info: RepoInfo, fix: boolean): Promise<TaskDoctorReport> {
  // catalog 只读、要跑 git，按「锁内不跑 git」放在锁外读一次。
  const catalog = readTrunkCatalog(info);
  const state = stateRoot(info);
  const fixed: string[] = [];
  const recoveryDecisions: RecoveryDecision[] = [];
  if (fix) {
    // 回滚 intent、隔离坏 live、回收过期 lease 都是写 live，必须独占全局锁。
    const candidates = await withLock(state, () => {
      fixPass(info, state, catalog, fixed);
      return listTaskLiveStates(state).lives
        .map(verificationCandidate)
        .filter((item): item is VerificationCandidate => item !== null);
    }, { createStateDir: false });
    for (const candidate of candidates) recoveryDecisions.push(await inspectVerification(candidate));
    if (recoveryDecisions.some((decision) => decision.recover)) {
      await withLock(state, () => {
        for (const decision of recoveryDecisions) recoverVerification(state, decision, fixed);
      }, { createStateDir: false });
    }
  }

  const states = listTaskLiveStates(state);
  const problems: string[] = [
    ...specProblems(catalog),
    ...states.corrupt.map((item) => describeProblem(item.file, item.error, 'cowork doctor --fix 隔离坏 live')),
    ...leaseProblems(info, catalog, states.lives),
  ];
  for (const item of listIntents(state)) {
    problems.push(
      describeProblem(item.file, `残留未完成 next 事务（${item.intent.task_id}）`, 'cowork doctor --fix 回滚，或重新运行 cowork next'),
    );
  }
  const notices = [
    ...staleArtifacts(state).map((artifact) =>
    `${artifact.path}: ${artifact.kind === 'lock.tmp' ? '超过 60 秒的锁临时目录' : '超过 24 小时的 trash 条目'}；运行 cowork doctor --fix 清理`,
    ),
    ...unverifiedNotices(states.lives),
    ...recoveryDecisions.filter((decision) => !decision.recover).map((decision) =>
      `${decision.candidate.id}: ${decision.reason}；仅在确认原验证进程退出或 PID 已复用后恢复`,
    ),
  ];
  return { problems, fixed, notices };
}
