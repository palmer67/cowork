import { existsSync } from 'node:fs';
import path from 'node:path';
import { expiresAt, isExpired } from './claims.ts';
import { git, headCommit, type RepoInfo } from './git.ts';
import { buildContractAlerts, type ContractAlert } from './contracts.ts';
import { readHandoffs, type HandoffMeta } from './handoffs.ts';
import { withLock } from './mutex.ts';
import { listClaims, stateRoot, type ClaimRecord } from './store.ts';
import { collectTaskViews, type TaskView } from './taskops.ts';
import { listTaskLiveStates, type TaskLiveStates, type VerificationLive } from './taskstore.ts';
import { readTrunkCatalog } from './tasks.ts';
import { listWorktrees, type Worktree } from './worktrees.ts';

/**
 * 最近一次交接单。契约字段是 id 与 created_at；title/path 是给面板的附加信息，
 * 没有交接时四个字段都为 null。
 */
export interface SnapshotHandoff {
  id: string | null;
  created_at: string | null;
  title: string | null;
  path: string | null;
}

export interface SnapshotLane {
  /**
   * 车道目录名（相对 .cowork/lanes/），不是分支名；
   * null 表示主工作树（面板显示 (main)），与 ClaimRecord.lane 的约定一致。
   */
  lane: string | null;
  /** detached HEAD 时为 null。 */
  branch: string | null;
  head: string | null;
  /** 本行 Git 字段的采样时间，不承诺与其他车道来自同一瞬间。 */
  observed_at: string | null;
  /** null 表示读取失败，不能当成"干净"。 */
  dirty: boolean | null;
  changed_file_count: number | null;
  last_handoff: SnapshotHandoff;
  /** 交接单读取诊断（坏 front matter、读不了的文件）；不影响车道其他字段。 */
  handoff_diagnostics?: string[];
  /** worktree 缺失、Git 读取失败或交接目录不可读时出现；此时不可得字段为 null。 */
  error?: string;
}

export interface SnapshotClaim {
  path: string;
  kind: string;
  lane: string | null;
  branch: string | null;
  agent: string;
  pid: number;
  host: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface SnapshotTask {
  id: string;
  title: string;
  status: string;
  touches: string[];
  reads: string[];
  depends_on: string[];
  done_when: string[];
  assigned_lane: string | null;
  agent: string | null;
  spec_commit: string | null;
  updated_at: string | null;
  blocked_reason: string | null;
  verification: VerificationLive | null;
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  /** 面板服务响应附加的调用身份；CLI snapshot 本身不输出此字段。 */
  panel_agent?: string;
  repo: { root: string; head: string | null; trunk?: string };
  tasks: SnapshotTask[];
  task_diagnostics: string[];
  claims: SnapshotClaim[];
  contract_alerts: ContractAlert[];
  lanes: SnapshotLane[];
}

/**
 * 统计 `git status --porcelain=v1 -z --untracked-files=all` 的变更路径数。
 * 暂存/未暂存/删除/未跟踪都算；重命名和复制在 -z 下把源路径作为下一个 token，
 * 新旧一对只计 1。按路径去重，忽略项本来就不会出现在输出里。
 */
export function parseStatusCount(raw: string): number {
  const paths = new Set<string>();
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const x = token.charAt(0);
    const y = token.charAt(1);
    paths.add(token.slice(3));
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1;
  }
  return paths.size;
}

function timeValue(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function emptyHandoff(): SnapshotHandoff {
  return { id: null, created_at: null, title: null, path: null };
}

/** 交接单上的 lane 可能是目录名，也可能是分支名（如 dsh/m0），两者都匹配。 */
function latestHandoff(
  metas: readonly HandoffMeta[],
  lane: string | null,
  branch: string | null,
): SnapshotHandoff {
  const matching = metas.filter((meta) => {
    // 主工作树没有车道目录名，只能按分支匹配。
    if (lane !== null && meta.lane === lane) return true;
    return branch !== null && meta.lane === branch;
  });
  matching.sort((a, b) => {
    const left = timeValue(a.created_at);
    const right = timeValue(b.created_at);
    // 两边都无有效时间时不能用减法：-Infinity - (-Infinity) 是 NaN，排序结果未定义。
    if (left !== right) return right - left;
    return b.id.localeCompare(a.id);
  });
  const best = matching[0];
  if (best === undefined) return emptyHandoff();
  return { id: best.id, created_at: best.created_at, title: best.title, path: best.path };
}

type GitAttempt = { ok: true; out: string } | { ok: false; error: string };

function attempt(args: string[], cwd: string): GitAttempt {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function observeLane(worktree: Worktree, lane: string | null, info: RepoInfo): { entry: SnapshotLane; handoffs: HandoffMeta[] } {
  const lanePath = path.resolve(worktree.path);
  const entry: SnapshotLane = {
    lane,
    branch: worktree.branch,
    head: worktree.head === null ? null : worktree.head.slice(0, 7),
    observed_at: null,
    dirty: null,
    changed_file_count: null,
    last_handoff: emptyHandoff(),
  };
  if (!existsSync(lanePath)) {
    entry.observed_at = new Date().toISOString();
    entry.error = `工作树目录不存在（worktree 登记仍在）: ${lanePath}`;
    return { entry, handoffs: [] };
  }

  const head = attempt(['rev-parse', '--short', 'HEAD'], lanePath);
  if (head.ok) entry.head = head.out;

  const status = attempt(
    // Windows 长路径：不开 core.longpaths 时 git status 会在深目录上失败。
    ['-c', 'core.longpaths=true', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    lanePath,
  );
  entry.observed_at = new Date().toISOString();
  if (status.ok) {
    const count = parseStatusCount(status.out);
    entry.changed_file_count = count;
    entry.dirty = count > 0;
  } else {
    entry.error = `git status 读取失败: ${status.error}`;
  }

  const handoffs = readHandoffs(path.join(lanePath, '.cowork', 'notes'), info);
  if (handoffs.diagnostics.length > 0) {
    entry.handoff_diagnostics = handoffs.diagnostics;
    // notes 目录本身读不了时，这条车道的交接信息不可信，按错误暴露出来。
    if (handoffs.unreadable && entry.error === undefined) entry.error = handoffs.diagnostics[0];
  }
  entry.last_handoff = latestHandoff(handoffs.metas, lane, worktree.branch);
  return { entry, handoffs: handoffs.metas };
}

/** live 记录在 mutex 内一次读齐，映射/派生都在锁外做。 */
function mapClaims(records: readonly ClaimRecord[]): SnapshotClaim[] {
  const now = Date.now();
  return records.map((rec) => ({
    path: rec.display,
    kind: rec.kind,
    lane: rec.lane,
    branch: rec.branch,
    agent: rec.agentId,
    pid: rec.pid,
    host: rec.host,
    note: rec.note,
    createdAt: rec.createdAt,
    expiresAt: expiresAt(rec),
    expired: isExpired(rec, now),
  }));
}

/** Windows 路径大小写不敏感；用于识别主工作树。 */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function toSnapshotTask(view: TaskView): SnapshotTask {
  return {
    id: view.id,
    title: view.title,
    status: view.status,
    touches: view.touches,
    reads: view.reads,
    depends_on: view.depends_on,
    done_when: view.done_when,
    assigned_lane: view.assigned_lane,
    agent: view.agent,
    spec_commit: view.spec_commit,
    updated_at: view.updated_at,
    blocked_reason: view.blocked_reason,
    verification: view.verification,
  };
}

/** 面板唯一数据源；只读，不写 claims，也不创建状态目录。 */
export async function snapshot(info: RepoInfo): Promise<Snapshot> {
  // catalog 要跑 git，必须在锁外读；live（claims/task live）在锁内一次取齐。
  const catalog = readTrunkCatalog(info);
  const state = stateRoot(info);
  const live = await withLock(
    state,
    () => ({
      claims: listClaims(state),
      tasks: listTaskLiveStates(state) as TaskLiveStates,
    }),
    { createStateDir: false },
  );
  const claims = mapClaims(live.claims);
  const view = collectTaskViews(info, catalog, live.tasks);
  const tasks = view.views.map(toSnapshotTask);
  const taskDiagnostics = view.diagnostics.map((item) => `${item.file}: ${item.error}`);

  const lanesRoot = path.join(info.mainRoot, '.cowork', 'lanes');
  const lanes: SnapshotLane[] = [];
  const handoffs: HandoffMeta[] = [];
  for (const worktree of listWorktrees(info.mainRoot)) {
    // 主工作树也是一条工作树：Codex 之类在主工作树干活时，未提交改动同样要看得见。
    if (samePath(worktree.path, info.mainRoot)) {
      const observed = observeLane(worktree, null, info);
      lanes.push(observed.entry);
      handoffs.push(...observed.handoffs);
      continue;
    }
    const rel = path.relative(lanesRoot, path.resolve(worktree.path));
    // 按路径段判断，不能 startsWith('..')：合法车道名可以就叫 ..hidden。
    if (rel === '' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) continue;
    const observed = observeLane(worktree, rel.split(path.sep).join('/'), info);
    lanes.push(observed.entry);
    handoffs.push(...observed.handoffs);
  }
  lanes.sort((a, b) => {
    if (a.lane === null) return b.lane === null ? 0 : -1;
    if (b.lane === null) return 1;
    return a.lane.localeCompare(b.lane);
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: { root: info.mainRoot, head: headCommit(info.mainRoot), trunk: catalog.trunk },
    tasks,
    task_diagnostics: taskDiagnostics,
    claims,
    contract_alerts: buildContractAlerts(info, view.views, handoffs),
    lanes,
  };
}
