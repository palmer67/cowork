import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from './git.ts';
import { formatClaim, parseClaim } from './paths.ts';
import { listWorktrees, managedLaneName, type Worktree } from './worktrees.ts';

export interface HandoffContractChange {
  paths: string[];
  old: string;
  new: string;
  compatibility: string;
  affected_tasks: string[];
}

export interface HandoffMeta {
  id: string;
  created_at: string | null;
  title: string | null;
  path: string;
  lane: string;
  task_id: string | null;
  contracts_changed: HandoffContractChange[];
}

export interface HandoffsRead {
  metas: HandoffMeta[];
  diagnostics: string[];
  unreadable: boolean;
}

function frontMatter(text: string): string | null {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if (lines.find((line) => line.trim() !== '')?.trim() !== '---') return null;
  const start = lines.findIndex((line) => line.trim() === '---');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '---');
  return end < 0 ? null : lines.slice(start + 1, end).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTime(raw: string | null): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseContractChanges(value: unknown, file: string, info: RepoInfo, diagnostics: string[]): HandoffContractChange[] {
  if (!Array.isArray(value)) {
    diagnostics.push(`${path.basename(file)}: contracts_changed 必须是对象数组`);
    return [];
  }
  const changes: HandoffContractChange[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    if (record === null || !Array.isArray(record['paths']) || record['paths'].length === 0 || record['paths'].some((entry) => typeof entry !== 'string')) {
      diagnostics.push(`${path.basename(file)}: contracts_changed[${index}].paths 必须是非空字符串数组`);
      return;
    }
    const paths: string[] = [];
    for (const raw of record['paths'] as string[]) {
      try {
        paths.push(formatClaim(parseClaim(raw, info)));
      } catch (err) {
        diagnostics.push(`${path.basename(file)}: contracts_changed[${index}] 路径无效（${errorText(err)}）`);
        return;
      }
    }
    changes.push({
      paths: [...new Set(paths)],
      old: typeof record['old'] === 'string' && record['old'] !== '' ? record['old'] : '未说明',
      new: typeof record['new'] === 'string' && record['new'] !== '' ? record['new'] : '未说明',
      compatibility: typeof record['compatibility'] === 'string' && record['compatibility'] !== '' ? record['compatibility'] : '未说明',
      affected_tasks: Array.isArray(record['affected_tasks']) ? record['affected_tasks'].filter((entry): entry is string => typeof entry === 'string') : [],
    });
  });
  return changes;
}

/** Reads current and uncommitted handoffs. Invalid contract data is diagnosed, never treated silently as absent. */
export function readHandoffs(notesDir: string, info: RepoInfo): HandoffsRead {
  let names: string[];
  try {
    names = readdirSync(notesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { metas: [], diagnostics: [], unreadable: false };
    return { metas: [], diagnostics: [`无法读取交接目录 ${notesDir}: ${errorText(err)}`], unreadable: true };
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
    const rawTime = typeof meta['createdAt'] === 'string'
      ? meta['createdAt']
      : typeof meta['created_at'] === 'string'
        ? meta['created_at']
        : typeof meta['at'] === 'string' ? meta['at'] : null;
    const title = typeof meta['task'] === 'string' ? meta['task'] : typeof meta['title'] === 'string' ? meta['title'] : null;
    const changes = meta['contracts_changed'] === undefined ? [] : parseContractChanges(meta['contracts_changed'], file, info, diagnostics);
    const taskId = typeof meta['task_id'] === 'string' ? meta['task_id'] : typeof meta['taskId'] === 'string' ? meta['taskId'] : null;
    metas.push({
      id: typeof meta['id'] === 'string' && meta['id'] !== '' ? meta['id'] : path.basename(name, '.md'),
      created_at: normalizeTime(rawTime),
      title,
      path: file,
      lane,
      task_id: taskId,
      contracts_changed: changes,
    });
  }
  return { metas, diagnostics, unreadable: false };
}

export function readRepositoryHandoffs(info: RepoInfo, worktrees = listWorktrees(info.mainRoot)): HandoffMeta[] {
  const all: HandoffMeta[] = [];
  for (const worktree of worktrees) {
    const lane = managedLaneName(info, worktree.path);
    if (lane === undefined || !existsSync(worktree.path)) continue;
    all.push(...readHandoffs(path.join(worktree.path, '.cowork', 'notes'), info).metas);
  }
  return all;
}

export function recentHandoffMetas(info: RepoInfo, worktree: Worktree): HandoffMeta[] {
  const lane = managedLaneName(info, worktree.path);
  if (lane === undefined || !existsSync(worktree.path)) return [];
  return readHandoffs(path.join(worktree.path, '.cowork', 'notes'), info).metas;
}
