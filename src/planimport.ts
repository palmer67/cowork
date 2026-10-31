import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { general } from './errors.ts';
import type { RepoInfo } from './git.ts';
import { stateRoot } from './store.ts';
import { withLock } from './mutex.ts';
import { formatClaim, parseClaim } from './paths.ts';
import { renderTaskSpec, specDir, type TaskSpec } from './tasks.ts';

export interface PlanTask {
  key: string;
  title: string;
  body: string;
  touches: string[];
  reads: string[];
  depends_on: string[];
  done_when: string[];
}

export interface ImportedTask {
  key: string;
  id: string;
  depends_on: string[];
  path: string;
}

export interface ImportPlanResult {
  tasks: ImportedTask[];
  specs: TaskSpec[];
  dryRun: boolean;
}

const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;

function issue(message: string, hint = '修正 plan.json 后重试。'): never {
  throw general(`计划导入失败: ${message}`, hint);
}

function stringField(value: unknown, name: string, index: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    issue(`tasks[${index}].${name} 必须是${allowEmpty ? '字符串' : '非空字符串'}`);
  }
  return value as string;
}

function stringArray(value: unknown, name: string, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issue(`tasks[${index}].${name} 必须是字符串数组`);
  }
  return (value as string[]).map((item) => item.trim()).filter((item) => item !== '');
}

function parsePlan(text: string): PlanTask[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    issue(`JSON 解析失败（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) issue('根对象必须是 JSON 对象');
  const root = value as Record<string, unknown>;
  if (root['schemaVersion'] !== 1) issue('schemaVersion 必须是 1');
  if (!Array.isArray(root['tasks']) || root['tasks'].length === 0) issue('tasks 必须是非空数组');

  const tasks: PlanTask[] = [];
  const problems: string[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < (root['tasks'] as unknown[]).length; index += 1) {
    const raw = (root['tasks'] as unknown[])[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`tasks[${index}] 必须是对象`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    let key: string;
    let title: string;
    let body: string;
    let touches: string[];
    let reads: string[];
    let depends_on: string[];
    let done_when: string[];
    try { key = stringField(item['key'], 'key', index); } catch (err) { problems.push(errorMessage(err)); continue; }
    if (!KEY.test(key)) problems.push(`tasks[${index}].key 格式无效: ${key}`);
    if (keys.has(key)) problems.push(`key 重复: ${key}`);
    keys.add(key);
    try { title = stringField(item['title'], 'title', index); } catch (err) { problems.push(errorMessage(err)); continue; }
    if ([...title].length > 120) problems.push(`tasks[${index}].title 超过 120 字符`);
    try { touches = stringArray(item['touches'], 'touches', index); } catch (err) { problems.push(errorMessage(err)); continue; }
    if (touches.length === 0) problems.push(`tasks[${index}].touches 不能为空`);
    try { reads = stringArray(item['reads'], 'reads', index); } catch (err) { problems.push(errorMessage(err)); continue; }
    const overlap = touches.find((entry) => reads.includes(entry));
    if (overlap !== undefined) problems.push(`tasks[${index}] 路径同时出现在 touches 与 reads: ${overlap}`);
    try {
      body = stringField(item['body'] ?? '', 'body', index, true);
      depends_on = stringArray(item['depends_on'], 'depends_on', index);
      done_when = stringArray(item['done_when'], 'done_when', index);
    } catch (err) { problems.push(errorMessage(err)); continue; }
    tasks.push({ key, title, body, touches, reads, depends_on, done_when });
  }

  const byKey = new Map(tasks.map((task) => [task.key, task]));
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dep of task.depends_on) {
      if (!byKey.has(dep)) problems.push(`${task.key} 依赖未知 key: ${dep}`);
      if (dep === task.key) problems.push(`${task.key} 不能依赖自己`);
      if (seen.has(dep)) problems.push(`${task.key} 依赖重复: ${dep}`);
      seen.add(dep);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      problems.push('依赖图存在环');
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)?.depends_on ?? []) visit(dep);
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of tasks) visit(task.key);
  if (problems.length > 0) issue(problems.join('\n- '));
  return tasks;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^计划导入失败: /, '') : String(err);
}

function newId(title: string, createdAt: string, taken: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const salt = randomBytes(8).toString('hex');
    const hex = createHash('sha256').update(`${title}\n${createdAt}\n${salt}`).digest('hex');
    const id = `t-${hex.slice(0, 6)}`;
    if (!taken.has(id)) return id;
  }
  issue('无法分配任务 id', '稍后重试。');
}

function existingIds(dir: string): Set<string> {
  // IDs are only used to avoid collisions; malformed filenames are harmless here.
  try {
    return new Set(readdirSync(dir).filter((name) => /^t-[0-9a-f]{6}\.md$/.test(name)).map((name) => name.slice(0, -3)));
  } catch {
    return new Set();
  }
}

export async function importPlan(info: RepoInfo, file: string, options: { dryRun?: boolean } = {}): Promise<ImportPlanResult> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    issue(`无法读取 ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tasks = parsePlan(text).map((task) => ({
    ...task,
    touches: task.touches.map((raw) => formatClaim(parseClaim(raw, info))),
    reads: task.reads.map((raw) => formatClaim(parseClaim(raw, info))),
  }));
  const createdAt = new Date().toISOString();
  const dir = specDir(info);
  const taken = existingIds(dir);
  const ids = new Map<string, string>();
  for (const task of tasks) {
    const id = newId(task.title, createdAt, taken);
    taken.add(id);
    ids.set(task.key, id);
  }
  const specs = tasks.map((task) => {
    const id = ids.get(task.key) as string;
    return {
      schemaVersion: 1 as const,
      id,
      title: task.title,
      touches: task.touches,
      reads: task.reads,
      depends_on: task.depends_on.map((key) => ids.get(key) as string),
      done_when: task.done_when,
      contracts: [],
      created_at: createdAt,
      meta: {},
      body: task.body,
      path: path.join(dir, `${id}.md`),
      specCommit: null,
    } satisfies TaskSpec;
  });
  if (options.dryRun) return { tasks: specs.map((spec, i) => ({ key: tasks[i]!.key, id: spec.id, depends_on: spec.depends_on, path: spec.path })), specs, dryRun: true };

  const written: string[] = [];
  await withLock(stateRoot(info), () => {
    mkdirSync(dir, { recursive: true });
    try {
      for (const spec of specs) {
        writeFileSync(spec.path, renderTaskSpec(spec), { encoding: 'utf8', flag: 'wx' });
        written.push(spec.path);
      }
    } catch (err) {
      for (const filePath of written) {
        try { unlinkSync(filePath); } catch { /* best effort rollback */ }
      }
      issue(`写入任务规格失败（${err instanceof Error ? err.message : String(err)}）`, '本批次已回滚，请检查 .cowork/tasks 是否可写。');
    }
  }, { createStateDir: false });
  return { tasks: specs.map((spec, i) => ({ key: tasks[i]!.key, id: spec.id, depends_on: spec.depends_on, path: spec.path })), specs, dryRun: false };
}

export function planFromText(text: string): PlanTask[] {
  return parsePlan(text);
}
