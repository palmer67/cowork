import { hostname } from 'node:os';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { busy, general } from './errors.ts';
import { currentBranch, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { agentId, claimTtlMs, isExpired } from './claims.ts';
import { conflicts, formatClaim, parseClaim, type ClaimPath } from './paths.ts';
import {
  asClaimPath,
  claimId,
  ensureState,
  listClaims,
  readClaim,
  readStateDir,
  removeClaim,
  stateRoot,
  writeClaim,
  type ClaimRecord,
} from './store.ts';
import {
  markCorrupt,
  readTaskLive,
  taskLiveFile,
  transitionTask,
  writeTaskLive,
  type TaskLive,
} from './taskstore.ts';
import { readTrunkCatalog, type TaskCatalog, type TaskSpec } from './tasks.ts';

/**
 * `next` 的崩溃安全事务。要点见 .cowork/notes/2026-10-30-m1-next-transaction.md：
 * 锁外读 catalog 得候选集 C；锁内先恢复 intent，重算 C' 再决定；写 intent → lease →
 * claims → intent committed → 删除 intent。任何一步失败都整单回滚，回滚失败标 corrupt。
 */

export type IntentPhase = 'pending' | 'committed';

export interface NextIntent {
  schemaVersion: 1;
  operation_id: string;
  task_id: string;
  lane: string | null;
  lane_path: string;
  agent: string;
  branch: string | null;
  /** 事务前的完整 live；null 表示原先没有 live 记录。 */
  prev: TaskLive | null;
  /** 本事务拟写/已写的 claim id（由路径哈希得到，稳定可重算）。 */
  claim_ids: string[];
  phase: IntentPhase;
  created_at: string;
}

export interface RecoveryReport {
  /** 按 intent 回滚掉的事务（任务回到可领取）。 */
  recovered: string[];
  /** committed intent 核对无误后清掉的残留。 */
  cleaned: string[];
  corrupt: string[];
}

export interface NextResult {
  task: TaskSpec;
  live: TaskLive;
  claims: ClaimRecord[];
  specCommit: string;
  recovery: RecoveryReport;
}

export interface NextOptions {
  agent?: string;
  lane?: string | null;
  lanePath?: string;
  timeoutMs?: number;
  onWait?: (owner: unknown) => void;
  /** 测试注入：跳过 trunk 读取。 */
  catalog?: TaskCatalog;
}

const HELD_STATUSES: readonly string[] = ['claimed', 'in_progress', 'reported_done', 'blocked'];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function intentsDir(state: string): string {
  return path.join(state, 'tasks', 'intents');
}

export function intentFile(state: string, operationId: string): string {
  return path.join(intentsDir(state), `${operationId}.json`);
}

function asString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string') {
    throw general(`next intent 损坏: ${file}（${field} 必须是字符串）`, '运行 cowork doctor 查看；人工核对后可删除 intent。');
  }
  return value;
}

function asNullable(value: unknown, field: string, file: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field, file);
}

function readIntentFile(file: string): NextIntent {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw general(
      `next intent 损坏: ${file}（${message(err)}）`,
      '不能安全回滚，拒绝继续；运行 cowork doctor 查看，人工核对后再删 intent。',
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw general(`next intent 损坏: ${file}（不是 JSON 对象）`, '人工核对后再删 intent。');
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) {
    throw general(`next intent 损坏: ${file}（schemaVersion 必须是 1）`, '人工核对后再删 intent。');
  }
  const phase = record['phase'];
  if (phase !== 'pending' && phase !== 'committed') {
    throw general(`next intent 损坏: ${file}（phase 只能是 pending/committed）`, '人工核对后再删 intent。');
  }
  const claimIds = record['claim_ids'];
  if (!Array.isArray(claimIds) || claimIds.some((id) => typeof id !== 'string')) {
    throw general(`next intent 损坏: ${file}（claim_ids 必须是字符串数组）`, '人工核对后再删 intent。');
  }
  const prev = record['prev'];
  return {
    schemaVersion: 1,
    operation_id: asString(record['operation_id'], 'operation_id', file),
    task_id: asString(record['task_id'], 'task_id', file),
    lane: asNullable(record['lane'], 'lane', file),
    lane_path: asString(record['lane_path'], 'lane_path', file),
    agent: asString(record['agent'], 'agent', file),
    branch: asNullable(record['branch'], 'branch', file),
    prev: prev === null || prev === undefined ? null : (prev as TaskLive),
    claim_ids: claimIds as string[],
    phase,
    created_at: asString(record['created_at'], 'created_at', file),
  };
}

export function listIntents(state: string): { file: string; intent: NextIntent }[] {
  const dir = intentsDir(state);
  return readStateDir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return { file, intent: readIntentFile(file) };
    });
}

export function writeIntent(state: string, intent: NextIntent): void {
  const file = intentFile(state, intent.operation_id);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw general(`无法写入 next intent: ${file}（${message(err)}）`, '检查 .git/cowork/tasks/intents 是否可写。');
  }
}

export function removeIntent(state: string, operationId: string): void {
  rmSync(intentFile(state, operationId), { force: true });
}

/**
 * 回滚一个 intent：只删本 intent 写的 claims（lane/lanePath/agent 必须匹配），
 * 再把 live 恢复成 prev（prev=null 时删除 live 文件）。幂等：重复调用结果一致。
 */
function rollback(state: string, intent: NextIntent): void {
  for (const id of intent.claim_ids) {
    const record = readClaim(state, id);
    if (record === null) continue;
    if (
      record.lane === intent.lane &&
      record.lanePath === intent.lane_path &&
      record.agentId === intent.agent
    ) {
      removeClaim(state, id);
    }
  }
  if (intent.prev === null) rmSync(taskLiveFile(state, intent.task_id), { force: true });
  else writeTaskLive(state, intent.prev);
}

/** committed intent 的核对：live 与全部 claims 必须齐全且属于同一 owner。 */
function verifyCommitted(state: string, intent: NextIntent): void {
  const live = readTaskLive(state, intent.task_id);
  if (live === null) {
    throw general(`committed intent 对应的 live 缺失: ${intent.task_id}`, '事务状态不完整，拒绝继续。');
  }
  if (live.status === 'merged' || live.status === 'cancelled') return;
  if (live.lane !== intent.lane || live.lanePath !== intent.lane_path || live.agent !== intent.agent) {
    throw general(
      `committed intent 与 live 的持有者不一致: ${intent.task_id}`,
      `intent: lane=${intent.lane ?? '(main)'} agent=${intent.agent}；live: lane=${live.lane ?? '(main)'} agent=${live.agent ?? '(无)'}。`,
    );
  }
  if (!HELD_STATUSES.includes(live.status)) {
    throw general(
      `committed intent 的 live 状态异常: ${intent.task_id} → ${live.status}`,
      '任务可能被手工改动；核对后修复 live 或删除 intent。',
    );
  }
  for (const id of intent.claim_ids) {
    const record = readClaim(state, id);
    if (record === null) {
      throw general(
        `committed intent 缺少 claim: ${id}（task ${intent.task_id}）`,
        '拒绝把任务开放给第二个 owner。',
      );
    }
    if (
      record.lane !== intent.lane ||
      record.lanePath !== intent.lane_path ||
      record.agentId !== intent.agent
    ) {
      throw general(`committed intent 的 claim 归属不一致: ${id}`, '核对 claim 文件后修复。');
    }
  }
}

/**
 * 取得锁后、做任何读写之前调用。无 committed → 回滚；有 committed → 核对后清残留。
 * 任一失败：标记 corrupt 并抛错（fail closed）。
 */
export function recoverIntents(state: string): RecoveryReport {
  const report: RecoveryReport = { recovered: [], cleaned: [], corrupt: [] };
  for (const { intent } of listIntents(state)) {
    try {
      if (intent.phase === 'pending') {
        rollback(state, intent);
        removeIntent(state, intent.operation_id);
        report.recovered.push(intent.task_id);
      } else {
        verifyCommitted(state, intent);
        removeIntent(state, intent.operation_id);
        report.cleaned.push(intent.task_id);
      }
    } catch (err) {
      report.corrupt.push(intent.task_id);
      try {
        markCorrupt(state, intent.task_id, `恢复 next 事务失败: ${message(err)}`);
      } catch {
        // 连 corrupt 标记都写不进去：保留原始错误继续抛出。
      }
      throw general(
        `恢复 next 事务失败，任务已标记 corrupt: ${intent.task_id}`,
        `原因: ${message(err)}。运行 cowork doctor 查看；人工核对 live/claims 后再继续。`,
      );
    }
  }
  return report;
}

interface World {
  lives: Map<string, TaskLive>;
  claims: ClaimRecord[];
}

function readWorld(state: string): World {
  const lives = new Map<string, TaskLive>();
  // 读不出来必须 fail closed：读不出的任务不能被当成"没有任务"。
  const names = readStateDir(path.join(state, 'tasks'));
  for (const name of names.filter((item) => /^t-[0-9a-f]{6}\.json$/.test(item))) {
    const live = readTaskLive(state, name.slice(0, -5));
    if (live !== null) lives.set(live.id, live);
  }
  const claims = listClaims(state).filter((record) => !isExpired(record));
  return { lives, claims };
}

interface CandidateSet {
  tasks: TaskSpec[];
  reasons: string[];
}

function describeClaimOwner(record: ClaimRecord): string {
  const lane = record.lane === null ? '(main)' : record.lane;
  const agent = record.agentId === 'default' ? '' : ` agent=${record.agentId}`;
  return `lane ${lane}${agent} 于 ${record.createdAt}`;
}

/**
 * spec.touches 存的是规范化展示形式（prefix 带 /**），这里换算成冲突键。
 * 解析基准取当前工作树根；key 是仓库根相对路径，跨 worktree 一致。
 */
function touchPaths(spec: TaskSpec, info: RepoInfo): ClaimPath[] {
  return spec.touches.map((touch) => parseClaim(touch, info));
}

/** 候选：ready + 依赖全 merged + touches 与未过期 claims/held lease 都不冲突。 */
function candidates(info: RepoInfo, catalog: TaskCatalog, world: World): CandidateSet {
  const statusOf = (id: string): string => world.lives.get(id)?.status ?? 'draft';
  const specById = catalog.specs;
  const ready = [...specById.values()]
    .filter((spec) => statusOf(spec.id) === 'ready')
    .sort((a, b) => {
      const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });

  const tasks: TaskSpec[] = [];
  const reasons: string[] = [];
  for (const spec of ready) {
    const blockedBy: string[] = [];
    for (const dep of spec.depends_on) {
      const depStatus = statusOf(dep);
      if (depStatus !== 'merged') {
        const title = specById.get(dep)?.title ?? dep;
        blockedBy.push(`依赖 ${dep}（${title}）尚未 merged，当前 ${depStatus}`);
      }
    }
    if (blockedBy.length > 0) {
      reasons.push(`${spec.id}（${spec.title}）: ${blockedBy.join('；')}`);
      continue;
    }
    const touches = touchPaths(spec, info);
    let clash: string | null = null;
    for (const touch of touches) {
      const owner = world.claims.find((record) => conflicts(touch, asClaimPath(record)));
      if (owner !== undefined) {
        clash = `${formatClaim(touch)} 与占位 ${formatClaim(asClaimPath(owner))} 冲突（${describeClaimOwner(owner)}）`;
        break;
      }
      for (const [id, live] of world.lives) {
        if (id === spec.id) continue;
        if (!HELD_STATUSES.includes(live.status)) continue;
        const held = specById.get(id);
        if (held === undefined) continue;
        const overlap = touchPaths(held, info).find((heldTouch) => conflicts(touch, heldTouch));
        if (overlap !== undefined) {
          const lane = live.lane === null ? '(main)' : live.lane;
          const agent = live.agent === null || live.agent === 'default' ? '' : ` agent=${live.agent}`;
          clash = `${formatClaim(touch)} 与 ${id} 的 ${formatClaim(overlap)} 重叠（lane ${lane}${agent}）`;
          break;
        }
      }
      if (clash !== null) break;
    }
    if (clash !== null) {
      reasons.push(`${spec.id}（${spec.title}）: ${clash}`);
      continue;
    }
    tasks.push(spec);
  }
  return { tasks, reasons };
}

function pickWinner(
  previous: CandidateSet,
  world: World,
): { task: TaskSpec; live: TaskLive } | null {
  for (const task of previous.tasks) {
    const live = world.lives.get(task.id);
    if (live !== undefined && HELD_STATUSES.includes(live.status)) return { task, live };
  }
  return null;
}

/**
 * 领取下一个 ready 任务。锁外读 catalog 得 C；锁内恢复 intent、重算 C'；
 * C' 空且 C 非空 → exit 2；都空 → exit 1 并打印阻塞原因。
 */
export async function next(info: RepoInfo, options: NextOptions = {}): Promise<NextResult> {
  const catalog = options.catalog ?? readTrunkCatalog(info);
  const state = stateRoot(info);
  ensureState(state);
  const agent = options.agent ?? agentId();
  const lane = options.lane === undefined ? info.laneName : options.lane;
  const lanePath = options.lanePath ?? info.laneTop;

  // 锁外：只为区分 exit 1/2，不参与写决策。
  const before = candidates(info, catalog, readWorld(state));
  // 分支也要在锁外读：currentBranch 会 spawn git，不能放进短临界区。
  const laneBranch = currentBranch(info.laneTop);
  const claimBranch = currentBranch(lanePath);

  return withLock(
    state,
    async () => {
      const recovery = recoverIntents(state);
      const world = readWorld(state);
      const after = candidates(info, catalog, world);
      if (after.tasks.length === 0) {
        const winner = pickWinner(before, world);
        if (winner !== null) {
          const laneName = winner.live.lane === null ? '(main)' : winner.live.lane;
          const agentName = winner.live.agent ?? 'default';
          throw busy(
            `任务已被领取: ${winner.task.id}（${winner.task.title}）← lane ${laneName} agent ${agentName} 于 ${winner.live.updated_at}`,
            '另一个 agent 在锁外候选与取锁之间领走了它；重跑 cowork next 领取下一个任务。',
          );
        }
        const detail =
          after.reasons.length === 0 ? '：没有 ready 状态的任务' : `\n${after.reasons.join('\n')}`;
        throw general(
          `没有可领取的任务${detail}`,
          '先让依赖任务 merged，或等占用者 cowork release；用 cowork task ls 看全部状态。',
        );
      }
      const task = after.tasks[0] as TaskSpec;
      const acquired = acquire(info, state, catalog, task, agent, lane, lanePath, laneBranch, claimBranch);
      return { ...acquired, task, specCommit: catalog.rev, recovery };
    },
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onWait === undefined ? {} : { onWait: options.onWait }),
    },
  );
}

/** 锁内事务本体：intent → lease → claims → committed → 清 intent。分支由调用方在锁外算好。 */
function acquire(
  info: RepoInfo,
  state: string,
  catalog: TaskCatalog,
  task: TaskSpec,
  agent: string,
  lane: string | null,
  lanePath: string,
  laneBranch: string | null,
  claimBranch: string | null,
): { live: TaskLive; claims: ClaimRecord[] } {
  const prev = readTaskLive(state, task.id);
  if (prev === null || prev.status !== 'ready') {
    throw busy(
      `任务状态在锁内发生变化: ${task.id} → ${prev?.status ?? '(无 live)'}`,
      '重跑 cowork next；锁外的候选集只用来判断退出码，不作为写依据。',
    );
  }
  const touches = touchPaths(task, info);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const touch of touches) {
    const id = claimId(touch);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  // 清掉过期 claim，避免事务途中被它们挡住。
  for (const record of listClaims(state)) {
    if (isExpired(record)) removeClaim(state, record.id);
  }
  const operationId = `${task.id}-${Date.now().toString(36)}-${process.pid}`;
  const createdAt = new Date().toISOString();
  const intent: NextIntent = {
    schemaVersion: 1,
    operation_id: operationId,
    task_id: task.id,
    lane,
    lane_path: lanePath,
    agent,
    branch: laneBranch,
    prev,
    claim_ids: ids,
    phase: 'pending',
    created_at: createdAt,
  };
  writeIntent(state, intent);
  let committed = false;
  try {
    const live = transitionTask(state, task.id, 'claimed', {
      agent,
      lane,
      lanePath,
      specCommit: catalog.rev,
      note: `next 领取（${catalog.trunk}@${catalog.rev.slice(0, 7)}）`,
    });
    const claims = writeTaskClaims(state, lane, lanePath, task.id, agent, touches, ids, createdAt, claimBranch);
    writeIntent(state, { ...intent, phase: 'committed' });
    committed = true;
    removeIntent(state, operationId);
    return { live, claims };
  } catch (err) {
    if (!committed) {
      try {
        rollback(state, intent);
        removeIntent(state, operationId);
      } catch (rollbackError) {
        try {
          markCorrupt(state, task.id, `回滚 next 事务失败: ${message(rollbackError)}`);
        } catch {
          // 标记失败时保留原始错误。
        }
        throw general(
          `next 事务失败且回滚未完成，任务已标记 corrupt: ${task.id}`,
          `原始错误: ${message(err)}；回滚错误: ${message(rollbackError)}。运行 cowork doctor 查看。`,
        );
      }
    }
    throw err;
  }
}

function writeTaskClaims(
  state: string,
  lane: string | null,
  lanePath: string,
  taskId: string,
  agent: string,
  touches: readonly ClaimPath[],
  ids: readonly string[],
  createdAt: string,
  branch: string | null,
): ClaimRecord[] {
  const host = hostname();
  const ttlMs = claimTtlMs();
  const records: ClaimRecord[] = touches.map((touch, index) => ({
    id: ids[index] as string,
    kind: touch.kind,
    key: touch.key,
    display: formatClaim(touch),
    lane,
    lanePath,
    branch,
    agentId: agent,
    pid: process.pid,
    host,
    note: `task ${taskId}`,
    createdAt,
    ttlMs,
  }));
  for (const record of records) writeClaim(state, record);
  return records;
}
