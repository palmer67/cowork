import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { general } from './errors.ts';
import { git, gitTry } from './git.ts';
import type { RepoInfo } from './git.ts';
import { formatClaim, parseClaim } from './paths.ts';

/**
 * M1 任务台：可提交的 spec（`.cowork/tasks/<id>.md`）与状态机。
 * 运行态（lease/history）在 src/taskstore.ts；这里只做纯数据与解析。
 */

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'claimed'
  | 'in_progress'
  | 'reported_done'
  | 'merged'
  | 'blocked'
  | 'cancelled';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'draft',
  'ready',
  'claimed',
  'in_progress',
  'reported_done',
  'merged',
  'blocked',
  'cancelled',
];

/** M2 的自动验证态；M1 出现即拒绝。 */
export const M2_STATUSES: readonly string[] = ['verifying', 'verify_failed', 'awaiting_merge'];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['reported_done', 'blocked', 'cancelled'],
  reported_done: ['merged', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  // "任意 → cancelled" 按字面执行：已合并的任务也能被取消（留痕在 history）。
  merged: ['cancelled'],
  cancelled: [],
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * 校验一次性状态转换。依赖只认 merged；blocked 必须带 reason；
 * M2 的自动验证态一律拒绝并给出 M1 的替代路径。
 */
export function assertTransition(from: TaskStatus, to: TaskStatus, reason?: string | null): void {
  if (M2_STATUSES.includes(to)) {
    throw general(
      `M1 没有自动验证态: ${to}`,
      'M1 未实现自动验证，请用 `cowork task confirm-merge --manual`（附 --commit <sha> 与 --reason <文本>）。',
    );
  }
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const next = allowed.length === 0 ? '无（终态）' : allowed.join(', ');
    throw general(
      `非法状态转换: ${from} → ${to}（允许的下一步: ${next}）`,
      from === to
        ? '状态已经是目标值；不需要重复操作。'
        : '按 draft → ready → claimed → in_progress → reported_done → merged 推进；blocked 只能从 claimed/in_progress 进入。',
    );
  }
  if (to === 'blocked' && (reason === undefined || reason === null || reason.trim() === '')) {
    throw general('blocked 必须带 --reason', '写清被什么阻塞（缺依赖、环境问题、等评审），解除后 task start 回 in_progress。');
  }
}

export interface TaskSpec {
  schemaVersion: 1;
  id: string;
  title: string;
  /** 规范化后的声明路径；prefix 统一带 /** 后缀。 */
  touches: string[];
  reads: string[];
  depends_on: string[];
  done_when: string[];
  contracts: unknown[];
  created_at: string;
  /** 原始 front matter：未知字段原样保留，不做 schema 升级。 */
  meta: Record<string, unknown>;
  /** spec 正文（front matter 之后）。 */
  body: string;
  /** spec 文件绝对路径；从 trunk catalog 读出的为 null。 */
  path: string | null;
  /** 读到该 spec 的提交；本地工作树未提交为 null。 */
  specCommit: string | null;
}

export interface TaskDiagnostic {
  file: string;
  error: string;
}

export interface TaskCatalog {
  /** 配置里的 trunk 引用，例如 main。 */
  trunk: string;
  /** 解析后的提交号（catalog 来自这个固定 commit）。 */
  rev: string;
  specs: Map<string, TaskSpec>;
  diagnostics: TaskDiagnostic[];
}

const TASK_ID = /^t-[0-9a-f]{6}$/;
const TASK_FILE = /^t-[0-9a-f]{6}\.md$/;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalid(file: string, detail: string): Error {
  return general(
    `任务规格无效: ${file}（${detail}）`,
    '修正 front matter 后重试；spec 进入 ready 后不得改写，要改请先 cancel 再重建。',
  );
}

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

export function specDir(info: RepoInfo): string {
  return path.join(info.laneTop, '.cowork', 'tasks');
}

export function specFile(info: RepoInfo, id: string): string {
  return path.join(specDir(info), `${id}.md`);
}

/** 拆出 --- 包裹的 JSON front matter；坏数据必须带文件名报错，不能静默跳过。 */
export function extractFrontMatter(text: string, file: string): { meta: unknown; body: string } {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (line.trim() !== '---') break;
    start = i;
    break;
  }
  if (start < 0) throw invalid(file, '缺少 --- 包裹的 JSON front matter');
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid(file, 'front matter 没有结束的 ---');
  const json = lines.slice(start + 1, end).join('\n');
  let meta: unknown;
  try {
    meta = JSON.parse(json);
  } catch (err) {
    throw invalid(file, `front matter 不是合法 JSON（${message(err)}）`);
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw invalid(file, 'front matter 不是 JSON 对象');
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd();
  return { meta, body };
}

function readString(meta: Record<string, unknown>, key: string, file: string): string {
  const value = meta[key];
  if (typeof value !== 'string') throw invalid(file, `${key} 必须是字符串`);
  return value;
}

function readArray(meta: Record<string, unknown>, key: string, file: string): string[] {
  const value = meta[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(file, `${key} 必须是字符串数组`);
  }
  return value as string[];
}

function normalizeDeclared(raw: string, info: RepoInfo): string {
  return formatClaim(parseClaim(raw, info));
}

/**
 * 解析 spec 文本。所有字段都必须显式且类型正确；未知字段留在 meta 里原样保留。
 * info 用于复用 src/paths.ts 的路径规范化（lowercase key + junction 检查）。
 */
export function parseTaskSpec(
  text: string,
  file: string,
  info: RepoInfo,
  specCommit: string | null = null,
): TaskSpec {
  const { meta, body } = extractFrontMatter(text, file);
  const record = meta as Record<string, unknown>;
  const schemaVersion = record['schemaVersion'];
  if (schemaVersion !== 1) throw invalid(file, `schemaVersion 必须是 1（读到 ${JSON.stringify(schemaVersion)}）`);
  const id = readString(record, 'id', file);
  if (!isTaskId(id)) throw invalid(file, `id 必须是 t-<6 位十六进制>（读到 ${id}）`);
  const title = readString(record, 'title', file).trim();
  if (title === '') throw invalid(file, 'title 不能为空');
  const createdAt = readString(record, 'created_at', file);
  if (Number.isNaN(Date.parse(createdAt))) throw invalid(file, `created_at 不是合法时间: ${createdAt}`);

  const rawTouches = readArray(record, 'touches', file);
  if (rawTouches.length === 0) throw invalid(file, 'touches 不能为空');
  const touches: string[] = [];
  for (const raw of rawTouches) {
    try {
      touches.push(normalizeDeclared(raw, info));
    } catch (err) {
      throw invalid(file, `touches 路径无效: ${message(err)}`);
    }
  }
  const reads: string[] = [];
  for (const raw of readArray(record, 'reads', file)) {
    try {
      reads.push(normalizeDeclared(raw, info));
    } catch (err) {
      throw invalid(file, `reads 路径无效: ${message(err)}`);
    }
  }

  const dependsOn = readArray(record, 'depends_on', file);
  const seen = new Set<string>();
  for (const dep of dependsOn) {
    if (!isTaskId(dep)) throw invalid(file, `depends_on 里的 ${dep} 不是任务 id（t-<6 位十六进制>）`);
    if (dep === id) throw invalid(file, 'depends_on 不能引用自己');
    if (seen.has(dep)) throw invalid(file, `depends_on 重复: ${dep}`);
    seen.add(dep);
  }

  const doneWhen = readArray(record, 'done_when', file).map((item) => item.trim()).filter((item) => item !== '');
  const contracts = record['contracts'] === undefined ? [] : record['contracts'];
  if (!Array.isArray(contracts)) throw invalid(file, 'contracts 必须是数组');

  return {
    schemaVersion: 1,
    id,
    title,
    touches,
    reads,
    depends_on: dependsOn,
    done_when: doneWhen,
    contracts,
    created_at: createdAt,
    meta: record,
    body,
    path: file,
    specCommit,
  };
}

/** 供 doctor/snapshot 使用：不抛异常，坏数据变成诊断项。 */
export function tryParseTaskSpec(
  text: string,
  file: string,
  info: RepoInfo,
  specCommit: string | null = null,
): { spec: TaskSpec | null; error: string | null } {
  try {
    return { spec: parseTaskSpec(text, file, info, specCommit), error: null };
  } catch (err) {
    return { spec: null, error: message(err) };
  }
}

/** 把 spec 渲染成可提交的 markdown；meta 中未知字段原样带回去。 */
export function renderTaskSpec(spec: TaskSpec): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: 1,
    id: spec.id,
    title: spec.title,
    touches: spec.touches,
    reads: spec.reads,
    depends_on: spec.depends_on,
    done_when: spec.done_when,
    contracts: spec.contracts,
    created_at: spec.created_at,
  };
  for (const [key, value] of Object.entries(spec.meta)) {
    if (key in ordered) continue;
    ordered[key] = value;
  }
  return `---\n${JSON.stringify(ordered, null, 2)}\n---\n\n${spec.body}\n`;
}

/** t-<6 hex> = sha256(title + created_at + 随机盐) 截断；碰撞就换盐。 */
export function newTaskId(title: string, createdAt: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const salt = randomBytes(8).toString('hex');
    const hex = createHash('sha256').update(`${title}\n${createdAt}\n${salt}`).digest('hex');
    const id = `t-${hex.slice(0, 6)}`;
    if (!taken.has(id)) return id;
  }
  throw general('无法分配任务 id', '连续 64 次哈希碰撞；检查 title/created_at 是否被固定成常量。');
}

export function listSpecIds(info: RepoInfo): string[] {
  let names: string[];
  try {
    names = readdirSync(specDir(info));
  } catch {
    return [];
  }
  return names
    .filter((name) => TASK_FILE.test(name))
    .map((name) => name.slice(0, -3))
    .sort();
}

export interface NewSpecInput {
  title: string;
  touches: readonly string[];
  reads?: readonly string[];
  depends_on?: readonly string[];
  done_when?: readonly string[];
  body?: string;
}

const DEFAULT_BODY = '## 背景\n\n## 验收说明\n';

/**
 * 创建 draft spec 并写盘。只写 `.cowork/tasks/<id>.md`，不碰 live。
 * depends_on 的存在性/成环校验需要 trunk catalog，由命令层负责。
 */
export function createSpec(info: RepoInfo, input: NewSpecInput, now = new Date()): TaskSpec {
  const title = input.title.trim();
  if (title === '') {
    throw general('任务标题不能为空', '用法: cowork task add --title <文本> --touches <路径> ...');
  }
  if (input.touches.length === 0) {
    throw general(
      'touches 不能为空',
      '至少一个 --touches <路径>；touches 决定领取时的文件占位，空列表等于不声明范围。',
    );
  }
  const touches = input.touches.map((raw) => normalizeDeclared(raw, info));
  const reads = (input.reads ?? []).map((raw) => normalizeDeclared(raw, info));
  const dependsOn = [...new Set(input.depends_on ?? [])];
  for (const dep of dependsOn) {
    if (!isTaskId(dep)) throw general(`--depends 需要任务 id（t-<6 位十六进制）: ${dep}`, '例如 --depends t-3f9a1c。');
  }
  const doneWhen = (input.done_when ?? []).map((item) => item.trim()).filter((item) => item !== '');
  const createdAt = now.toISOString();
  const dir = specDir(info);
  mkdirSync(dir, { recursive: true });
  const taken = new Set(listSpecIds(info));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newTaskId(title, createdAt, taken);
    const file = path.join(dir, `${id}.md`);
    const spec: TaskSpec = {
      schemaVersion: 1,
      id,
      title,
      touches,
      reads,
      depends_on: dependsOn,
      done_when: doneWhen,
      contracts: [],
      created_at: createdAt,
      meta: {},
      body: input.body ?? DEFAULT_BODY,
      path: file,
      specCommit: null,
    };
    try {
      writeFileSync(file, renderTaskSpec(spec), { encoding: 'utf8', flag: 'wx' });
      return spec;
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string }).code;
      if (code !== 'EEXIST') {
        throw general(
          `无法写入任务规格: ${file}（${message(err)}）`,
          '检查 .cowork/tasks 是否存在且可写、磁盘是否已满。',
        );
      }
      taken.add(id);
    }
  }
  throw general(`无法分配任务 id（${message(lastError)}）`, '同一秒内冲突过多；稍后重试。');
}

/** 本地工作树里的全部 spec；坏文件进诊断，不拖垮列表。 */
export function listLocalSpecs(info: RepoInfo): { specs: TaskSpec[]; diagnostics: TaskDiagnostic[] } {
  const specs: TaskSpec[] = [];
  const diagnostics: TaskDiagnostic[] = [];
  for (const id of listSpecIds(info)) {
    const file = specFile(info, id);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      diagnostics.push({ file, error: `无法读取（${message(err)}）` });
      continue;
    }
    const parsed = tryParseTaskSpec(text, file, info);
    if (parsed.spec === null) diagnostics.push({ file, error: parsed.error ?? '未知解析错误' });
    else specs.push(parsed.spec);
  }
  return { specs, diagnostics };
}

/** 配置里的 trunk 引用；.cowork/config.json 由 init 写入，缺省 main。 */
export function readTrunk(info: RepoInfo): string {
  const file = path.join(info.laneTop, '.cowork', 'config.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { trunk?: unknown };
    if (typeof raw.trunk === 'string' && raw.trunk.trim() !== '') return raw.trunk.trim();
  } catch {
    // 没有 config 或坏 JSON：退回 main，命令层会在 trunk 不可达时报错。
  }
  return 'main';
}

/**
 * 从配置 trunk 的固定 commit 读整个 catalog（git ls-tree + git show）。
 * 必须锁外调用；锁内只读 live 状态。
 */
export function readTrunkCatalog(info: RepoInfo, trunk = readTrunk(info)): TaskCatalog {
  let rev: string;
  try {
    rev = git(['rev-parse', '--verify', `${trunk}^{commit}`], info.mainRoot);
  } catch (err) {
    throw general(
      `无法解析 trunk 的提交: ${trunk}（${message(err)}）`,
      '确认 .cowork/config.json 里的 trunk 指向一个存在的分支（默认 main），且仓库至少有一个提交。',
    );
  }
  const listing = gitTry(['ls-tree', '-r', '--name-only', rev, '--', '.cowork/tasks'], info.mainRoot) ?? '';
  const specs = new Map<string, TaskSpec>();
  const diagnostics: TaskDiagnostic[] = [];
  for (const rel of listing.split(/\r?\n/)) {
    if (rel === '' || !rel.endsWith('.md')) continue;
    let text: string;
    try {
      text = git(['show', `${rev}:${rel}`], info.mainRoot);
    } catch (err) {
      diagnostics.push({ file: `${rel}@${rev.slice(0, 7)}`, error: `无法读取 blob（${message(err)}）` });
      continue;
    }
    const parsed = tryParseTaskSpec(text, rel, info, rev);
    if (parsed.spec === null) {
      diagnostics.push({ file: `${rel}@${rev.slice(0, 7)}`, error: parsed.error ?? '未知解析错误' });
      continue;
    }
    if (specs.has(parsed.spec.id)) {
      diagnostics.push({ file: rel, error: `trunk 上有重复 id: ${parsed.spec.id}` });
      continue;
    }
    specs.set(parsed.spec.id, parsed.spec);
  }
  return { trunk, rev, specs, diagnostics };
}

/** 沿着 depends_on 找环；返回含首尾重复节点的环，便于直接打印。 */
export function findDependencyCycle(
  spec: TaskSpec,
  specs: ReadonlyMap<string, TaskSpec>,
): string[] | null {
  const stack: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start < 0 ? 0 : start), id];
    }
    if (done.has(id)) return null;
    const current = specs.get(id);
    if (current === undefined) return null;
    visiting.add(id);
    stack.push(id);
    for (const dep of current.depends_on) {
      const found = walk(dep);
      if (found !== null) return found;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };
  return walk(spec.id);
}

/**
 * 校验 depends_on：只能引用 trunk catalog 里存在、非 cancelled 的任务，且不能成环。
 * statusOf 返回 null 表示还没有 live 记录（等价 draft）。
 */
export function checkDependencies(
  spec: TaskSpec,
  catalog: ReadonlyMap<string, TaskSpec>,
  statusOf: (id: string) => TaskStatus | null,
): void {
  for (const dep of spec.depends_on) {
    const depSpec = catalog.get(dep);
    if (depSpec === undefined) {
      throw general(
        `依赖的任务不在 trunk catalog: ${dep}`,
        `先把 ${dep} 的 spec 合并到 trunk，或去掉 --depends ${dep}。`,
      );
    }
    if (statusOf(dep) === 'cancelled') {
      throw general(`依赖的任务已取消: ${dep}（${depSpec.title}）`, '换一个依赖，或取消本条任务后重建。');
    }
  }
  const cycle = findDependencyCycle(spec, catalog);
  if (cycle !== null) {
    throw general(`依赖成环: ${cycle.join(' → ')}`, '打断环上的任意一条 depends_on 后重试。');
  }
}
