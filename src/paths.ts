import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { general } from './errors.ts';
import type { RepoInfo } from './git.ts';

export type ClaimKind = 'file' | 'prefix';

/**
 * 一条声明路径。key 是**主仓库根相对**的逻辑路径：
 * - posix 分隔符、无前导 ./ 、无尾随 /、小写折叠（近似 NTFS $UpCase）
 * - 必须能跨 worktree 比较：车道 A 的 src/a.ts 与车道 B 的 src/a.ts 必须是同一个 key
 */
export interface ClaimPath {
  kind: ClaimKind;
  key: string;
}

const DRIVE = /^[A-Za-z]:/;
const WILDCARDS = /[*?[\]{}]/;

function isAbsoluteLike(raw: string): boolean {
  return DRIVE.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\');
}

/** 判断 prefix a 是否覆盖 path b（b 可为文件或前缀）。 */
export function covers(a: string, b: string): boolean {
  return b === a || b.startsWith(a + '/');
}

export function conflicts(a: ClaimPath, b: ClaimPath): boolean {
  if (a.key === b.key) return true;
  if (a.kind === 'file' && b.kind === 'file') return false;
  if (a.kind === 'prefix' && b.kind === 'prefix') {
    return covers(a.key, b.key) || covers(b.key, a.key);
  }
  if (a.kind === 'prefix') return covers(a.key, b.key);
  return covers(b.key, a.key);
}

export function formatClaim(p: ClaimPath): string {
  return p.kind === 'prefix' ? `${p.key}/**` : p.key;
}

function statIsDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** 用 realpath 消歧（8.3 短名、junction、大小写），失败时退回原路径。 */
function realKey(laneTop: string, key: string): string {
  const abs = path.resolve(laneTop, ...key.split('/'));
  let realAbs: string;
  let realLane: string;
  try {
    realAbs = realpathSync.native(abs);
    realLane = realpathSync.native(laneTop);
  } catch {
    return key;
  }
  const rel = path.relative(realLane, realAbs);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw general(
      `路径解析后落在仓库之外: ${key}`,
      '符号链接/junction 指向了仓库外部，cowork 不跟踪仓库外的文件。',
    );
  }
  return rel.split(path.sep).join('/');
}

/**
 * 把命令行/任务单里的路径解析成冲突键。
 * 只接受仓库根相对路径；盘符、UNC、绝对路径、.. 逃逸一律拒绝（退出 1）。
 */
export function parseClaim(input: string, info: RepoInfo): ClaimPath {
  const original = input;
  let raw = input.trim().replace(/\\/g, '/');
  if (raw === '') throw general('路径不能为空', '用法: cowork claim <路径>...');

  if (isAbsoluteLike(raw)) {
    throw general(
      `不接受绝对路径: ${original}`,
      '请使用仓库根相对路径，例如 src/auth/login.ts；车道之间用同一个相对路径比较冲突。',
    );
  }

  raw = raw.replace(/^\.\//, '');

  let kind: ClaimKind = 'file';
  if (raw.endsWith('/**')) {
    kind = 'prefix';
    raw = raw.slice(0, -3);
  } else if (raw.endsWith('/')) {
    kind = 'prefix';
    raw = raw.replace(/\/+$/, '');
  }

  const segments = raw.split('/');
  if (segments.some((s) => s === '..')) {
    throw general(
      `路径不能包含 ..: ${original}`,
      '声明路径必须是仓库内的固定位置，不允许向上逃逸。',
    );
  }
  const key0 = segments.filter((s) => s !== '' && s !== '.').join('/');
  if (key0 === '') {
    throw general(
      `不能声明仓库根: ${original}`,
      '根前缀会吞掉所有其他路径，等于把整个仓库锁住。请声明具体文件或非根目录前缀。',
    );
  }
  if (WILDCARDS.test(key0)) {
    throw general(
      `不支持通配符: ${original}`,
      '只支持两种形式：精确文件（src/a.ts）和递归目录前缀（src/auth 或 src/auth/**）。',
    );
  }

  if (kind === 'file' && statIsDir(path.resolve(info.laneTop, ...key0.split('/')))) {
    kind = 'prefix';
  }

  const real = realKey(info.laneTop, key0);
  if (real === '') {
    throw general(
      `不能声明仓库根: ${original}`,
      '解析后的路径就是仓库根，等于锁住整个仓库。',
    );
  }

  return { kind, key: real.toLowerCase() };
}

export function claimPathsEqual(a: ClaimPath, b: ClaimPath): boolean {
  return a.kind === b.kind && a.key === b.key;
}
