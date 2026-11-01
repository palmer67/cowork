import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { general } from './errors.ts';
import { git, gitTry, type RepoInfo } from './git.ts';
import { readTrunk } from './tasks.ts';
import { listWorktrees, managedLaneName } from './worktrees.ts';

export interface MergeHunk {
  lane_start: number;
  lane_end: number;
  base_start: number;
  base_end: number;
}

export interface MergeConflict {
  path: string;
  kind: 'content' | 'whole_file';
  hunks: MergeHunk[];
}

export interface MergePreview {
  schema_version: 1;
  lane: string;
  branch: string;
  lane_head: string;
  base_ref: string;
  base_head: string;
  merge_base: string | null;
  can_merge: boolean;
  conflicts: MergeConflict[];
}

function run(args: string[], cwd: string): { code: number; out: string; error: string } {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error !== undefined) throw general(`无法运行 Git（${result.error.message}）`, '检查 Git 安装与仓库目录。');
  return { code: result.status ?? 1, out: result.stdout, error: result.stderr };
}

function commit(ref: string, cwd: string): string {
  // --end-of-options 防止把 ref 当成选项；之后始终使用已解析的 SHA。
  const sha = gitTry(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd);
  if (sha === null) throw general(`无法解析提交: ${ref}`, '检查车道分支及 --base（默认 config.trunk）是否存在且有提交。');
  return sha;
}

interface DiffHunk { old_start: number; old_count: number; start: number; count: number }

function hunks(ancestor: string, head: string, file: string, cwd: string): DiffHunk[] {
  const diff = git([
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0',
    ancestor, head, '--', file,
  ], cwd);
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    old_start: Number(match[1]), old_count: Number(match[2] ?? 1),
    start: Number(match[3]), count: Number(match[4] ?? 1),
  }));
}

function overlaps(left: DiffHunk, right: DiffHunk): boolean {
  if (left.old_count === 0 && right.old_count === 0) return left.old_start === right.old_start;
  if (left.old_count === 0) return left.old_start >= right.old_start - 1 && left.old_start < right.old_start + right.old_count;
  if (right.old_count === 0) return overlaps(right, left);
  return left.old_start < right.old_start + right.old_count && right.old_start < left.old_start + left.old_count;
}

function describeConflict(file: string, ancestor: string | null, base: string, lane: string, cwd: string): MergeConflict {
  const result: MergeConflict = { path: file, kind: 'whole_file', hunks: [] };
  if (ancestor === null) return result;
  // 缺失/二进制/重命名等冲突不伪造行号；只有可定位的文本重叠才列 hunk。
  const binary = git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', ancestor, base, '--', file], cwd)
    + git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', ancestor, lane, '--', file], cwd);
  if (/^-\t-\t/m.test(binary)) return result;
  const baseHunks = hunks(ancestor, base, file, cwd);
  const laneHunks = hunks(ancestor, lane, file, cwd);
  for (const ours of laneHunks) {
    for (const theirs of baseHunks) {
      if (ours.count === 0 || theirs.count === 0 || !overlaps(ours, theirs)) continue;
      result.hunks.push({
        lane_start: ours.start, lane_end: ours.start + ours.count - 1,
        base_start: theirs.start, base_end: theirs.start + theirs.count - 1,
      });
    }
  }
  if (result.hunks.length > 0) result.kind = 'content';
  return result;
}

/** 老 Git 的兼容路径：只在系统临时区克隆，源仓库不登记临时 worktree 或引用。 */
export function previewMergeInTemp(info: RepoInfo, base: string, lane: string): string[] {
  const temp = mkdtempSync(path.join(tmpdir(), 'cowork-merge-'));
  const checkout = path.join(temp, 'repo');
  const config = [
    '-c', `core.hooksPath=${path.join(temp, 'hooks')}`, '-c', 'core.longpaths=true',
    '-c', 'rerere.enabled=false', '-c', 'merge.autostash=false',
    '-c', 'user.name=cowork-preview', '-c', 'user.email=preview@localhost',
  ];
  try {
    for (const args of [
      ['clone', '--shared', '--no-checkout', '--no-hardlinks', '--', info.mainRoot, checkout],
    ]) {
      const cloned = run(args, temp);
      if (cloned.code !== 0) throw general(`无法建立临时合并目录: ${cloned.error.trim()}`, '检查系统临时区权限与 Git 安装。');
    }
    const detached = run([...config, 'checkout', '--detach', base], checkout);
    if (detached.code !== 0) throw general(`无法读取预演基线: ${detached.error.trim()}`);
    const merged = run([...config, 'merge', '--no-commit', '--no-ff', lane], checkout);
    if (merged.code === 0) return [];
    const unmerged = run([...config, 'diff', '--name-only', '--diff-filter=U', '-z'], checkout);
    if (merged.code !== 1 || unmerged.code !== 0 || unmerged.out === '') {
      throw general(`临时合并预演失败: ${merged.error.trim() || merged.out.trim()}`, '检查两侧历史是否有共同祖先。');
    }
    return unmerged.out.split('\0').filter(Boolean);
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

/** 只读预演。没有锁、状态恢复、checkout、index 或源仓库临时引用。 */
export function previewMerge(info: RepoInfo, laneName: string, baseRef = readTrunk(info)): MergePreview {
  const worktree = listWorktrees(info.mainRoot).find((item) =>
    managedLaneName(info, item.path) === laneName || item.branch === laneName,
  );
  if (worktree === undefined || worktree.branch === null || managedLaneName(info, worktree.path) === undefined) {
    throw general(`找不到有分支的车道: ${laneName}`, '用 cowork status 查看车道名或分支名；detached HEAD 不能作为车道分支。');
  }
  const lane = commit(worktree.branch, info.mainRoot);
  const base = commit(baseRef, info.mainRoot);
  const ancestor = gitTry(['merge-base', base, lane], info.mainRoot);
  const merged = run(['merge-tree', '--write-tree', '--name-only', '-z', base, lane], info.mainRoot);
  let files: string[];
  if (merged.code === 0 || merged.code === 1) {
    const tokens = merged.out.split('\0');
    if (!/^[0-9a-f]{40,64}$/.test(tokens[0] ?? '')) {
      throw general(`合并预演失败: ${merged.error.trim() || merged.out.trim()}`, '检查两侧历史与 Git merge-tree 输出。');
    }
    const end = tokens.indexOf('', 1);
    files = merged.code === 0 ? [] : tokens.slice(1, end < 0 ? undefined : end);
    if (merged.code === 1 && files.length === 0) throw general('Git 报告冲突但未返回文件', '检查 Git merge-tree 输出。');
  } else if (/unknown (?:option|switch)|unrecognized option|usage: git merge-tree/i.test(merged.error)) {
    files = previewMergeInTemp(info, base, lane);
  } else {
    throw general(`合并预演失败: ${merged.error.trim() || merged.out.trim()}`, '检查两侧历史是否有共同祖先，以及仓库是否可读。');
  }
  return {
    schema_version: 1, lane: managedLaneName(info, worktree.path) ?? laneName,
    branch: worktree.branch, lane_head: lane, base_ref: baseRef, base_head: base,
    merge_base: ancestor, can_merge: files.length === 0,
    conflicts: [...new Set(files)].sort().map((file) => describeConflict(file, ancestor, base, lane, info.mainRoot)),
  };
}

export function renderMergePreview(preview: MergePreview): string {
  const lines = [`预演：lane ${preview.lane} ← ${preview.base_ref}@${preview.base_head.slice(0, 7)}`];
  if (preview.can_merge) return [...lines, '可合：0 个文件冲突'].join('\n');
  const count = preview.conflicts.reduce((sum, conflict) => sum + Math.max(1, conflict.hunks.length), 0);
  lines.push(`冲突 ${preview.conflicts.length} 个文件 / ${count} 处`);
  for (const conflict of preview.conflicts) {
    if (conflict.kind === 'whole_file') lines.push(`  ${conflict.path}  整文件冲突（无法安全定位文本 hunk）`);
    for (const hunk of conflict.hunks) {
      lines.push(`  ${conflict.path}  hunk ${hunk.lane_start}-${hunk.lane_end}  与 ${preview.base_ref} 的 ${hunk.base_start}-${hunk.base_end} 重叠`);
    }
  }
  return lines.join('\n');
}
