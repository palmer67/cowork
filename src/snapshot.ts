import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expiresAt, isExpired } from './claims.ts';
import { git, headCommit, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { listClaims, stateRoot } from './store.ts';

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
  /** 车道目录名（相对 .cowork/lanes/），不是分支名。 */
  lane: string;
  /** detached HEAD 时为 null。 */
  branch: string | null;
  head: string | null;
  /** 本行 Git 字段的采样时间，不承诺与其他车道来自同一瞬间。 */
  observed_at: string | null;
  /** null 表示读取失败，不能当成"干净"。 */
  dirty: boolean | null;
  changed_file_count: number | null;
  last_handoff: SnapshotHandoff;
  /** worktree 缺失或 Git 读取失败时出现；此时不可得字段为 null。 */
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

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  repo: { root: string; head: string | null };
  tasks: unknown[];
  claims: SnapshotClaim[];
  contract_alerts: unknown[];
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

/** 读该车道工作树里可见（含未提交）的交接单；坏文件跳过，不影响整份快照。 */
function readHandoffs(notesDir: string): HandoffMeta[] {
  if (!existsSync(notesDir)) return [];
  const out: HandoffMeta[] = [];
  for (const name of readdirSync(notesDir)) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(notesDir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const body = frontMatter(text);
    if (body === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      continue;
    }
    const meta = asRecord(raw);
    if (meta === null) continue;
    const lane = typeof meta['lane'] === 'string' ? meta['lane'].trim() : '';
    if (lane === '') continue;
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
    out.push({ id, created_at: normalizeTime(rawTime), title, path: file, lane });
  }
  return out;
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
  lane: string,
  branch: string | null,
): SnapshotHandoff {
  const matching = metas.filter(
    (meta) => meta.lane === lane || (branch !== null && meta.lane === branch),
  );
  matching.sort((a, b) => {
    const byTime = timeValue(b.created_at) - timeValue(a.created_at);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
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

function observeLane(worktree: Worktree, lane: string): SnapshotLane {
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
    entry.error = `车道目录不存在（worktree 登记仍在）: ${lanePath}`;
    return entry;
  }

  const head = attempt(['rev-parse', '--short', 'HEAD'], lanePath);
  if (head.ok) entry.head = head.out;

  const status = attempt(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
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

  entry.last_handoff = latestHandoff(
    readHandoffs(path.join(lanePath, '.cowork', 'notes')),
    lane,
    worktree.branch,
  );
  return entry;
}

/**
 * live 状态只在 mutex 内读，Git 只读命令都在锁外跑：临界区不能持锁跑 git。
 * 状态目录还不存在时没有 live 状态可读，也不该为了看一眼而把它建出来。
 */
async function readClaims(info: RepoInfo): Promise<SnapshotClaim[]> {
  const state = stateRoot(info);
  if (!existsSync(state)) return [];
  const records = await withLock(state, () => listClaims(state));
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

/** 面板唯一数据源；只读，不写 claims，也不创建状态目录。 */
export async function snapshot(info: RepoInfo): Promise<Snapshot> {
  const claims = await readClaims(info);

  const lanesRoot = path.join(info.mainRoot, '.cowork', 'lanes');
  const lanes: SnapshotLane[] = [];
  for (const worktree of listWorktrees(info.mainRoot)) {
    const resolved = path.resolve(worktree.path);
    const rel = path.relative(lanesRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    lanes.push(observeLane(worktree, rel.split(path.sep).join('/')));
  }
  lanes.sort((a, b) => a.lane.localeCompare(b.lane));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: { root: info.mainRoot, head: headCommit(info.mainRoot) },
    tasks: [],
    claims,
    contract_alerts: [],
    lanes,
  };
}
