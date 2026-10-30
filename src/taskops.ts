import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { busy, CoworkError, general } from './errors.ts';
import { git, gitTry, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { agentId } from './claims.ts';
import { conflicts, formatClaim, parseClaim } from './paths.ts';
import { claimId, listClaims, removeClaim, stateRoot } from './store.ts';
import {
  listTaskLiveStates,
  readTaskLive,
  transitionTask,
  type TaskLiveStates,
  type LiveStatus,
  type TaskLive,
} from './taskstore.ts';
import {
  createSpec,
  isTaskStatus,
  listLocalSpecs,
  readTrunk,
  readTrunkCatalog,
  type TaskCatalog,
  type TaskDiagnostic,
  type TaskSpec,
  type TaskStatus,
} from './tasks.ts';
import { recoverIntents } from './tasknext.ts';

/** 命令层：把 spec（trunk + 本地）与 live 合并成可展示/可操作视图。 */

export interface TaskView {
  id: string;
  title: string;
  status: LiveStatus;
  touches: string[];
  reads: string[];
  depends_on: string[];
  done_when: string[];
  assigned_lane: string | null;
  agent: string | null;
  spec_commit: string | null;
  updated_at: string | null;
  blocked_reason: string | null;
  spec_path: string | null;
}

export interface TaskListView {
  views: TaskView[];
  diagnostics: TaskDiagnostic[];
}

function toView(spec: TaskSpec, live: TaskLive | null): TaskView {
  return {
    id: spec.id,
    title: spec.title,
    status: live?.status ?? 'draft',
    touches: spec.touches,
    reads: spec.reads,
    depends_on: spec.depends_on,
    done_when: spec.done_when,
    assigned_lane: live?.lane ?? null,
    agent: live?.agent ?? null,
    spec_commit: live?.spec_commit ?? spec.specCommit,
    updated_at: live?.updated_at ?? null,
    blocked_reason: live?.blocked_reason ?? null,
    spec_path: spec.path,
  };
}

/** trunk catalog 为准；本地未提交的 draft 也列出（标成 draft，不参与 next）。 */
export function collectTaskViews(
  info: RepoInfo,
  catalog: TaskCatalog,
  liveStates: TaskLiveStates = listTaskLiveStates(stateRoot(info)),
): TaskListView {
  const local = listLocalSpecs(info);
  const lives = new Map<string, TaskLive>();
  const diagnostics: TaskDiagnostic[] = [...catalog.diagnostics, ...local.diagnostics];
  for (const live of liveStates.lives) lives.set(live.id, live);
  for (const item of liveStates.corrupt) diagnostics.push({ file: item.file, error: item.error });

  const specs = new Map<string, TaskSpec>(local.specs.map((spec) => [spec.id, spec] as [string, TaskSpec]));
  for (const [id, spec] of catalog.specs) specs.set(id, spec);
  const unknownLive = [...lives.values()].filter((live) => !specs.has(live.id));
  for (const live of unknownLive) {
    diagnostics.push({ file: `${live.id}.json`, error: 'live 存在但找不到对应 spec（trunk 与本地都没有）' });
  }

  const views = [...specs.values()]
    .filter((spec) => catalog.specs.has(spec.id) || spec.specCommit === null)
    .map((spec) => toView(spec, lives.get(spec.id) ?? null))
    .sort((a, b) => {
      const left = Date.parse(a.updated_at ?? '') || 0;
      const right = Date.parse(b.updated_at ?? '') || 0;
      if (left !== right) return left - right;
      return a.id.localeCompare(b.id);
    });
  return { views, diagnostics };
}

/** 写命令统一入口：锁内先恢复 intent，再执行；catalog 必须已在锁外读好。 */
async function withTaskLock<T>(
  info: RepoInfo,
  fn: (state: string) => T | Promise<T>,
  createStateDir = true,
): Promise<T> {
  const state = stateRoot(info);
  return withLock(
    state,
    async () => {
      recoverIntents(state);
      return await fn(state);
    },
    { createStateDir },
  );
}

function findSpec(info: RepoInfo, catalog: TaskCatalog, id: string): TaskSpec {
  const fromTrunk = catalog.specs.get(id);
  if (fromTrunk !== undefined) return fromTrunk;
  const local = listLocalSpecs(info).specs.find((spec) => spec.id === id);
  if (local !== undefined) return local;
  throw general(
    `找不到任务: ${id}`,
    '用 cowork task ls 查看现有 id；本地 draft 还没提交时也会列出。',
  );
}

function requireSpecInTrunk(catalog: TaskCatalog, id: string): TaskSpec {
  const spec = catalog.specs.get(id);
  if (spec !== undefined) return spec;
  throw general(
    `任务不在 trunk（${catalog.trunk}）上，不能 ready: ${id}`,
    'ready 只认 trunk 可达的 spec；先 commit 并合并到 trunk，再运行 cowork task ready。',
  );
}

export interface AddTaskInput {
  title: string;
  touches: readonly string[];
  reads: readonly string[];
  depends_on: readonly string[];
  done_when: readonly string[];
}

/** 只创建 draft spec；依赖存在性/取消状态用 trunk catalog 校验（不持锁跑 git）。 */
export async function addTask(info: RepoInfo, input: AddTaskInput): Promise<TaskSpec> {
  const catalog = readTrunkCatalog(info);
  for (const dep of input.depends_on) {
    const depSpec = catalog.specs.get(dep);
    if (depSpec === undefined) {
      throw general(`依赖的任务不在 trunk catalog: ${dep}`, `先把 ${dep} 的 spec 合并到 trunk，或去掉 --depends ${dep}。`);
    }
    if (readTaskLive(stateRoot(info), dep)?.status === 'cancelled') {
      throw general(`依赖的任务已取消: ${dep}（${depSpec.title}）`, '换一个依赖，或取消本条任务后重建。');
    }
  }
  return withTaskLock(info, () => createSpec(info, input), false);
}

export async function listTasks(info: RepoInfo, statusFilter: string | null): Promise<TaskListView> {
  if (statusFilter !== null && !isTaskStatus(statusFilter)) {
    throw general(`未知状态: ${statusFilter}`, '可用状态: draft/ready/claimed/in_progress/reported_done/merged/blocked/cancelled。');
  }
  const catalog = readTrunkCatalog(info);
  const list = collectTaskViews(info, catalog);
  if (statusFilter === null) return list;
  return { views: list.views.filter((view) => view.status === statusFilter), diagnostics: list.diagnostics };
}

export interface ShowTaskResult {
  view: TaskView;
  spec: TaskSpec;
  live: TaskLive | null;
}

export async function showTask(info: RepoInfo, id: string): Promise<ShowTaskResult> {
  const catalog = readTrunkCatalog(info);
  const spec = findSpec(info, catalog, id);
  const state = stateRoot(info);
  const live = readTaskLive(state, id);
  return { view: toView(spec, live), spec, live };
}

/** draft → ready：要求 spec 已在 trunk 可达，记录 spec_commit。 */
export async function readyTask(info: RepoInfo, id: string): Promise<TaskLive> {
  const catalog = readTrunkCatalog(info);
  requireSpecInTrunk(catalog, id);
  return withTaskLock(info, (state) => {
    const live = readTaskLive(state, id);
    if (live !== null && live.status !== 'draft') {
      throw general(
        `任务当前状态不能 ready: ${id} → ${live.status}`,
        '只有 draft 可以进入 ready；ready 之后 spec 不可改写，要改请 cancel 后重建。',
      );
    }
    return transitionTask(state, id, 'ready', {
      specCommit: catalog.rev,
      agent: null,
      note: `ready @${catalog.trunk}@${catalog.rev.slice(0, 7)}`,
    });
  });
}

function requireOwner(live: TaskLive, agent: string, action: string): void {
  if (live.agent === null || live.agent === agent) return;
  const lane = live.lane === null ? '(main)' : live.lane;
  throw busy(
    `任务 ${live.id} 被 lane ${lane} agent ${live.agent} 占着，${action} 需要持有者执行`,
    `用 COWORK_AGENT_ID=${live.agent} 或 --agent ${live.agent} 重试；确实要接管请先 cowork task cancel。`,
  );
}

function requireLive(state: string, id: string): TaskLive {
  const live = readTaskLive(state, id);
  if (live === null) {
    throw general(`任务没有 live 记录: ${id}`, '先 cowork task ready 让任务进入 ready，再用 cowork next 领取。');
  }
  return live;
}

export async function startTask(info: RepoInfo, id: string, agent: string): Promise<TaskLive> {
  return withTaskLock(info, (state) => {
    const live = requireLive(state, id);
    if (live.status !== 'claimed') {
      throw general(
        `任务当前状态不能 start: ${id} → ${live.status}`,
        'start 只适用于 claimed；先 cowork next 领取，或用 cowork task show 查看状态。',
      );
    }
    requireOwner(live, agent, 'start');
    return transitionTask(state, id, 'in_progress', { agent, note: 'start' });
  });
}

export async function reportDone(info: RepoInfo, id: string, agent: string): Promise<TaskLive> {
  return withTaskLock(info, (state) => {
    const live = requireLive(state, id);
    if (live.status !== 'in_progress') {
      throw general(
        `任务当前状态不能 report-done: ${id} → ${live.status}`,
        'report-done 只适用于 in_progress；先 cowork task start。',
      );
    }
    requireOwner(live, agent, 'report-done');
    return transitionTask(state, id, 'reported_done', { agent, note: 'report-done' });
  });
}

export async function blockTask(info: RepoInfo, id: string, agent: string, reason: string): Promise<TaskLive> {
  if (reason.trim() === '') {
    throw general('block 需要 --reason', '例如: cowork task block t-3f9a1c --reason "等设计确认"');
  }
  return withTaskLock(info, (state) => {
    const live = requireLive(state, id);
    requireOwner(live, agent, 'block');
    return transitionTask(state, id, 'blocked', { agent, reason, note: `blocked: ${reason}` });
  });
}

function releaseTaskClaims(info: RepoInfo, state: string, spec: TaskSpec): string[] {
  const released: string[] = [];
  for (const touch of spec.touches) {
    const claimPath = parseClaim(touch, info);
    if (removeClaim(state, claimId(claimPath))) released.push(formatClaim(claimPath));
  }
  return released;
}

export interface MergeResult {
  live: TaskLive;
  released: string[];
}

/** reported_done → merged；释放 lease 与全部 touches claim。M1 只接受 --manual。 */
export async function confirmMerge(
  info: RepoInfo,
  id: string,
  options: { commit: string; manual: boolean; reason: string | null },
): Promise<MergeResult> {
  if (options.commit.trim() === '') {
    throw general('confirm-merge 需要 --commit <sha>', '先合并任务分支，再用合并提交的 sha 确认。');
  }
  if (!options.manual) {
    throw general(
      'M1 没有自动验证，请加 --manual 并给出 --reason',
      'M2 才有 verifying / verify_failed；M1 用 cowork task confirm-merge <id> --commit <sha> --manual --reason "..."。',
    );
  }
  const reason = options.reason?.trim() ?? '';
  if (reason === '') {
    throw general('--manual 需要 --reason <文本>', '写清人工确认的依据（谁验的、验了什么）。');
  }
  const sha = gitTry(['rev-parse', '--verify', `${options.commit}^{commit}`], info.mainRoot);
  if (sha === null) {
    throw general(`无法解析合并提交: ${options.commit}`, '确认 sha 在当前仓库可见（至少一个分支或 FETCH_HEAD 包含它）。');
  }
  const catalog = readTrunkCatalog(info);
  const spec = findSpec(info, catalog, id);
  return withTaskLock(info, (state) => {
    const live = requireLive(state, id);
    if (live.status !== 'reported_done') {
      throw general(
        `任务当前状态不能 confirm-merge: ${id} → ${live.status}`,
        'confirm-merge 只适用于 reported_done；先 cowork task report-done。',
      );
    }
    const merged = transitionTask(state, id, 'merged', {
      lane: null,
      lanePath: null,
      agent: null,
      specCommit: spec.specCommit ?? live.spec_commit,
      note: `merged ${sha.slice(0, 7)}（人工确认：${reason}）`,
    });
    const released = releaseTaskClaims(info, state, spec);
    return { live: merged, released };
  });
}

export interface CancelResult {
  live: TaskLive;
  released: string[];
}

export async function cancelTask(
  info: RepoInfo,
  id: string,
  agent: string,
  reason: string | null,
): Promise<CancelResult> {
  const catalog = readTrunkCatalog(info);
  const spec = findSpec(info, catalog, id);
  return withTaskLock(info, (state) => {
    const live = requireLive(state, id);
    if (live.status === 'merged' || live.status === 'cancelled') {
      throw general(
        `任务当前状态不能 cancel: ${id} → ${live.status}`,
        '已 merged / cancelled 的任务不需要再取消。',
      );
    }
    requireOwner(live, agent, 'cancel');
    const cancelled = transitionTask(state, id, 'cancelled', {
      agent,
      lane: null,
      lanePath: null,
      note: reason === null ? 'cancel' : `cancel: ${reason}`,
    });
    const released = releaseTaskClaims(info, state, spec);
    return { live: cancelled, released };
  });
}

function noteSummary(file: string): { id: string; at: string; title: string } | null {
  try {
    const text = readFileSync(file, 'utf8');
    const first = text.indexOf('---');
    if (first < 0) return null;
    const second = text.indexOf('---', first + 3);
    if (second < 0) return null;
    const meta = JSON.parse(text.slice(first + 3, second)) as Record<string, unknown>;
    const id = typeof meta['id'] === 'string' ? meta['id'] : path.basename(file, '.md');
    const at =
      typeof meta['createdAt'] === 'string'
        ? meta['createdAt']
        : typeof meta['at'] === 'string'
          ? meta['at']
          : '';
    const title =
      typeof meta['task'] === 'string'
        ? meta['task']
        : (text.slice(second + 3).match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, '.md'));
    return { id, at, title };
  } catch {
    return null;
  }
}

export function recentHandoffs(info: RepoInfo, limit = 3): { id: string; at: string; title: string }[] {
  const dir = path.join(info.laneTop, '.cowork', 'notes');
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  return names
    .map((name) => noteSummary(path.join(dir, name)))
    .filter((item): item is { id: string; at: string; title: string } => item !== null)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

export interface BriefInput {
  agent: string;
  catalog: TaskCatalog;
}

/** 只读开工摘要：锁内短读 live/claims，catalog 已在锁外读好。 */
export async function brief(info: RepoInfo, input: BriefInput): Promise<string> {
  const catalog = input.catalog;
  const state = stateRoot(info);
  return withLock(
    state,
    async () => {
      recoverIntents(state);
      const lives = new Map<string, TaskLive>();
      for (const live of listTaskLiveStates(state).lives) lives.set(live.id, live);
      const claims = listClaims(state);
      const mine = lives.get(
        [...lives.values()].find(
          (live) =>
            live.lanePath === info.laneTop &&
            live.status !== 'merged' &&
            live.status !== 'cancelled' &&
            live.status !== 'corrupt',
        )?.id ?? '',
      );
      const lines: string[] = [];
      lines.push(`# 开工摘要（agent=${input.agent}，lane=${info.laneName ?? '(main)'}）`);
      lines.push('');
      if (mine === undefined) {
        lines.push('本 lane 当前没有任务。用 cowork next 领取一个 ready 任务。');
      } else {
        const spec = catalog.specs.get(mine.id) ?? listLocalSpecs(info).specs.find((item) => item.id === mine.id);
        lines.push(`本 lane 任务: ${mine.id} ${spec?.title ?? '(spec 不在 trunk)'}（${mine.status}）`);
        if (spec !== undefined) {
          lines.push(`  touches: ${spec.touches.join(', ') || '(空)'}`);
          lines.push(`  reads: ${spec.reads.join(', ') || '(空)'}`);
          lines.push(`  done_when: ${spec.done_when.join('; ') || '(空)'}`);
          lines.push(`  spec_commit: ${mine.spec_commit ?? '(无)'}`);
          lines.push('依赖:');
          if (spec.depends_on.length === 0) lines.push('  (无)');
          for (const dep of spec.depends_on) {
            const depLive = lives.get(dep);
            const status = depLive?.status ?? 'draft';
            const holder =
              depLive?.agent === null || depLive?.agent === undefined ? '' : `，agent ${depLive.agent}`;
            lines.push(`  ${dep}: ${status}${holder}${status === 'merged' ? '（已满足）' : '（未满足）'}`);
          }
        }
      }
      lines.push('');
      lines.push('本 lane 占位:');
      const laneClaims = claims.filter((record) => record.lanePath === info.laneTop);
      if (laneClaims.length === 0) lines.push('  (无)');
      for (const record of laneClaims) {
        lines.push(`  ${record.display}  agent=${record.agentId}  到期 ${record.createdAt}`);
      }
      lines.push('');
      lines.push('跨 lane 冲突（与本单位置重叠的 claim）:');
      const own = (mine === undefined ? [] : (catalog.specs.get(mine.id)?.touches ?? [])).map((touch) =>
        parseClaim(touch, info),
      );
      const clashes = claims.filter(
        (record) => record.lanePath !== info.laneTop && own.some((path) => conflicts(path, parseClaim(record.display, info))),
      );
      if (clashes.length === 0) lines.push('  (无)');
      for (const record of clashes) {
        lines.push(`  ${record.display}  lane=${record.lane ?? '(main)'} agent=${record.agentId}`);
      }
      lines.push('');
      lines.push('契约提醒（本任务 reads 与其他活跃任务 touches 的交集）:');
      const alerts: string[] = [];
      for (const spec of catalog.specs.values()) {
        const live = lives.get(spec.id);
        if (live === undefined || live.status === 'merged' || live.status === 'cancelled') continue;
        if (spec.id === mine?.id) continue;
        for (const read of mine === undefined ? [] : (catalog.specs.get(mine.id)?.reads ?? [])) {
          const readPath = parseClaim(read, info);
          for (const touch of spec.touches) {
            if (conflicts(readPath, parseClaim(touch, info))) {
              alerts.push(`  ${read}（读）↔ ${spec.id} ${touch}（写）`);
            }
          }
        }
      }
      lines.push(alerts.length === 0 ? '  (无)' : alerts.join('\n'));
      lines.push('');
      const handoffs = recentHandoffs(info);
      lines.push('最近交接单:');
      if (handoffs.length === 0) lines.push('  (无)');
      for (const handoff of handoffs) {
        lines.push(`  ${handoff.id}  ${handoff.at}  ${handoff.title}`);
      }
      lines.push('');
      lines.push('硬规则: 只改 touches 内的文件；越界前先 cowork claim 扩范围。');
      return lines.join('\n');
    },
    { createStateDir: false },
  );
}

export interface LaneNewResult {
  name: string;
  path: string;
  branch: string;
  base: string;
}

/** lane new：整条命令不持锁、不写 live（git worktree add 必须在锁外）。 */
export function laneNew(info: RepoInfo, name: string, baseRef: string | null): LaneNewResult {
  if (!/^[a-z0-9-]{1,32}$/.test(name) || name === '.' || name === '..') {
    throw general(
      `车道名不合法: ${name}`,
      '只允许小写字母、数字与 -，长度 1..32，且不能是 . 或 ..。',
    );
  }
  const dir = path.join(info.mainRoot, '.cowork', 'lanes', name);
  if (existsSync(dir)) {
    throw busy(`车道已存在: ${dir}`, '换一个名字，或删掉旧车道后重试（确认里面没有未提交改动）。');
  }
  const branch = `cowork/${name}`;
  if (gitTry(['rev-parse', '--verify', `refs/heads/${branch}`], info.mainRoot) !== null) {
    throw busy(`分支已存在: ${branch}`, '换一个车道名，或先删除既有分支。');
  }
  const base = baseRef ?? readTrunk(info);
  if (gitTry(['rev-parse', '--verify', `${base}^{commit}`], info.mainRoot) === null) {
    throw general(`无法解析 base: ${base}`, '用 --base 指定一个存在的分支或提交。');
  }
  try {
    git(['worktree', 'add', dir, '-b', branch, base], info.mainRoot);
  } catch (err) {
    throw general(
      `git worktree add 失败: ${dir}（${err instanceof CoworkError ? err.message : String(err)}）`,
      '检查 .cowork/lanes 是否可写、路径是否被占用。',
    );
  }
  return { name, path: dir, branch, base };
}

export function defaultAgent(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? agentId() : trimmed;
}

export function describeAgent(live: TaskLive | null): string {
  if (live === null || live.agent === null) return '(未领取)';
  const lane = live.lane === null ? '(main)' : live.lane;
  return `lane ${lane} agent ${live.agent}`;
}

export type { TaskStatus };
