import { git, type RepoInfo } from './git.ts';
import path from 'node:path';

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
}

/** `git worktree list --porcelain -z`: records are separated by empty tokens. */
export function listWorktrees(mainRoot: string): Worktree[] {
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
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
  }
  if (current !== null) out.push(current);
  return out;
}

/** Returns null for a worktree outside the repository root and managed lane directory. */
export function managedLaneName(info: RepoInfo, worktreePath: string): string | null | undefined {
  const root = path.resolve(info.mainRoot);
  const resolved = path.resolve(worktreePath);
  if (samePath(root, resolved)) return null;
  const lanesRoot = path.join(root, '.cowork', 'lanes');
  const rel = path.relative(lanesRoot, resolved);
  if (rel === '' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) return undefined;
  return rel.split(path.sep).join('/');
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
