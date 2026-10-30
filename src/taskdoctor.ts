import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { isExpired } from './claims.ts';
import { gitTry, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { listClaims, stateRoot } from './store.ts';
import {
  listTaskLiveStates,
  taskLiveFile,
  writeTaskLive,
  type TaskLive,
} from './taskstore.ts';
import { findDependencyCycle, readTrunkCatalog, type TaskCatalog } from './tasks.ts';
import { listIntents, recoverIntents } from './tasknext.ts';

export interface TaskDoctorReport {
  /** 仍未解决/需要人看的问题，每条都带文件与怎么修。 */
  problems: string[];
  /** --fix 本次实际修好的项。 */
  fixed: string[];
}

const LEASE_STATUSES = new Set(['claimed', 'in_progress']);

function describeProblem(file: string, issue: string, fix: string): string {
  return `${file}: ${issue}；${fix}`;
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
      const ancestor = gitTry(
        ['merge-base', '--is-ancestor', live.spec_commit, catalog.trunk],
        info.mainRoot,
      );
      if (ancestor === null) {
        problems.push(
          describeProblem(
            file,
            `lease 的 spec_commit ${live.spec_commit.slice(0, 7)} 不在 ${catalog.trunk} 历史里（spec 可能被改写）`,
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
    const alive = claims.some((claim) => claim.agentId === live.agent && !isExpired(claim, Date.now()));
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
}

/** 只读检查（--fix 时先修再查）。返回 problems 非空即 doctor 退出 1。 */
export async function doctorTasks(info: RepoInfo, fix: boolean): Promise<TaskDoctorReport> {
  // catalog 只读、要跑 git，按「锁内不跑 git」放在锁外读一次。
  const catalog = readTrunkCatalog(info);
  const state = stateRoot(info);
  const fixed: string[] = [];
  if (fix) {
    // 回滚 intent、隔离坏 live、回收过期 lease 都是写 live，必须独占全局锁。
    await withLock(state, () => fixPass(info, state, catalog, fixed), { createStateDir: false });
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
  return { problems, fixed };
}
