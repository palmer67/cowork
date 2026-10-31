import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expiresAt, isExpired } from './claims.ts';
import { git, headCommit, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { conflicts, parseClaim, type ClaimPath } from './paths.ts';
import { listClaims, stateRoot, type ClaimRecord } from './store.ts';
import { collectTaskViews, type TaskView } from './taskops.ts';
import { listTaskLiveStates, type TaskLiveStates } from './taskstore.ts';
import { readTrunkCatalog } from './tasks.ts';

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
}

/** reads ↔ 其他活跃任务 touches 的重叠提醒（M1 只报这一种契约冲突）。 */
export interface ContractAlert {
  kind: 'reads_touches';
  task: string;
  path: string;
  peer_task: string;
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  repo: { root: string; head: string | null; trunk?: string };
  tasks: SnapshotTask[];
  task_diagnostics: string[];
  claims: SnapshotClaim[];
  contract_alerts: ContractAlert[];
  lanes: SnapshotLane[];
}

interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
}

interface HandoffMeta {
  id: string;
  created_at: string | null;
  title: string | null;
  path: string;
  lane: string;
}

/** `git worktree list --porcelain -z`：记录之间用空 token 分隔。 */
function listWorktrees(mainRoot: string): Worktree[] {
  const raw = git(['worktree', 'list', '--porcelain', '-z'], mainRoot);
  const out: Worktree[] = [];
  let current: Worktree | null = null;
  for (const token of raw.split('\0')) {
    if (token === '') {
      if (current !== null) out.push(current);
      current = null;
      continue;
    }
    const space = token.indexOf(' ');
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? '' : token.slice(space + 1);
    if (key === 'worktree') {
      if (current !== null) out.push(current);
      current = { path: value, head: null, branch: null };
      continue;
    }
    if (current === null) continue;
    if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    }
  }
  if (current !== null) out.push(current);
  return out;
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

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function frontMatter(text: string): string | null {
  const match = FRONT_MATTER.exec(text);
  return match?.[1] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTime(raw: string | null): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

interface HandoffsRead {
  metas: HandoffMeta[];
  diagnostics: string[];
  /** notes 目录存在但读不了（权限、被占用、同名文件）。 */
  unreadable: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 读该车道工作树里可见（含未提交）的交接单。
 * 坏文件不让整份快照挂掉，但也不能静默：每一项都带上"哪份文件、什么原因"。
 */
function readHandoffs(notesDir: string): HandoffsRead {
  let names: string[];
  try {
    names = readdirSync(notesDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 没有 .cowork/notes 是正常情况（还没写过交接单）。
    if (code === 'ENOENT') return { metas: [], diagnostics: [], unreadable: false };
    return {
      metas: [],
      diagnostics: [`无法读取交接目录 ${notesDir}: ${errorText(err)}`],
      unreadable: true,
    };
  }
  const metas: HandoffMeta[] = [];
  const diagnostics: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(notesDir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      diagnostics.push(`${name}: 无法读取（${errorText(err)}）`);
      continue;
    }
    const body = frontMatter(text);
    if (body === null) {
      diagnostics.push(`${name}: 缺少 --- 包裹的 JSON front matter`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (err) {
      diagnostics.push(`${name}: front matter 不是合法 JSON（${errorText(err)}）`);
      continue;
    }
    const meta = asRecord(raw);
    if (meta === null) {
      diagnostics.push(`${name}: front matter 不是 JSON 对象`);
      continue;
    }
    const lane = typeof meta['lane'] === 'string' ? meta['lane'].trim() : '';
    if (lane === '') {
      diagnostics.push(`${name}: 缺少 lane 字段`);
      continue;
    }
    const rawTime =
      typeof meta['createdAt'] === 'string'
        ? meta['createdAt']
        : typeof meta['at'] === 'string'
          ? meta['at']
          : null;
    const id =
      typeof meta['id'] === 'string' && meta['id'] !== ''
        ? meta['id']
        : path.basename(name, '.md');
    const title =
      typeof meta['task'] === 'string'
        ? meta['task']
        : typeof meta['title'] === 'string'
          ? meta['title']
          : null;
    metas.push({ id, created_at: normalizeTime(rawTime), title, path: file, lane });
  }
  return { metas, diagnostics, unreadable: false };
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

function observeLane(worktree: Worktree, lane: string | null): SnapshotLane {
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
    return entry;
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

  const handoffs = readHandoffs(path.join(lanePath, '.cowork', 'notes'));
  if (handoffs.diagnostics.length > 0) {
    entry.handoff_diagnostics = handoffs.diagnostics;
    // notes 目录本身读不了时，这条车道的交接信息不可信，按错误暴露出来。
    if (handoffs.unreadable && entry.error === undefined) entry.error = handoffs.diagnostics[0];
  }
  entry.last_handoff = latestHandoff(handoffs.metas, lane, worktree.branch);
  return entry;
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
  };
}

const ACTIVE_STATUSES = new Set(['ready', 'claimed', 'in_progress', 'reported_done', 'blocked']);

/** 只提示"我在读、别人在写"的重叠；spec 路径已经过 paths.ts 规范化，这里再包一层容错。 */
function contractAlerts(info: RepoInfo, views: readonly TaskView[]): ContractAlert[] {
  const alerts: ContractAlert[] = [];
  const active = views.filter((view) => ACTIVE_STATUSES.has(view.status));
  const claimOf = (raw: string): ClaimPath | null => {
    try {
      return parseClaim(raw, info);
    } catch {
      return null;
    }
  };
  for (const reader of active) {
    const reads = reader.reads.map(claimOf).filter((item): item is ClaimPath => item !== null);
    if (reads.length === 0) continue;
    for (const writer of active) {
      if (writer.id === reader.id) continue;
      const touches = writer.touches.map(claimOf).filter((item): item is ClaimPath => item !== null);
      for (const read of reads) {
        const hit = touches.find((touch) => conflicts(read, touch));
        if (hit !== undefined) {
          alerts.push({ kind: 'reads_touches', task: reader.id, path: read.display, peer_task: writer.id });
        }
      }
    }
  }
  return alerts;
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
  for (const worktree of listWorktrees(info.mainRoot)) {
    // 主工作树也是一条工作树：Codex 之类在主工作树干活时，未提交改动同样要看得见。
    if (samePath(worktree.path, info.mainRoot)) {
      lanes.push(observeLane(worktree, null));
      continue;
    }
    const rel = path.relative(lanesRoot, path.resolve(worktree.path));
    // 按路径段判断，不能 startsWith('..')：合法车道名可以就叫 ..hidden。
    if (rel === '' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) continue;
    lanes.push(observeLane(worktree, rel.split(path.sep).join('/')));
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
    contract_alerts: contractAlerts(info, view.views),
    lanes,
  };
}
