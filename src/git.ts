import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CoworkError, EXIT, pathError } from './errors.ts';

export interface RepoInfo {
  /** 当前工作树根（可能是 .cowork/lanes/<name>）。 */
  laneTop: string;
  /** 共享的 git 目录，主仓库下即 <main>/.git；linked worktree 下仍是主仓库的 .git。 */
  commonDir: string;
  /** 主仓库根目录。所有冲突键都以它为基准。 */
  mainRoot: string;
  /** 当前工作树在 .cowork/lanes/ 下的名字；主工作树为 null。 */
  laneName: string | null;
}

function run(args: string[], cwd: string): string {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.replace(/\r?\n$/, '');
  } catch (err) {
    const tooLong = pathError(err, cwd);
    if (tooLong !== null) throw tooLong;
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr === undefined ? '' : Buffer.from(e.stderr).toString('utf8');
    const detail = (stderr || e.message || '').trim();
    throw new CoworkError(
      EXIT.ENV,
      `git ${args.join(' ')} 执行失败${detail === '' ? '' : `: ${detail}`}`,
      '确认当前目录在 Git 仓库内，且 PATH 中能找到 git（Windows 上通常是 D:\\Git\\bin）。',
    );
  }
}

export function git(args: string[], cwd = process.cwd()): string {
  return run(args, cwd);
}

/** 只用于探测，失败返回 null。 */
export function gitTry(args: string[], cwd = process.cwd()): string | null {
  try {
    return run(args, cwd);
  } catch (err) {
    const tooLong = pathError(err, cwd);
    if (tooLong !== null) throw tooLong;
    return null;
  }
}

export function laneNameOf(mainRoot: string, laneTop: string): string | null {
  const lanesRoot = path.join(mainRoot, '.cowork', 'lanes');
  const rel = path.relative(lanesRoot, laneTop);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * 解析仓库上下文。任何一条不成立都按「环境不满足」退出 3：
 * 冲突键依赖主仓库根与共享 git 目录，猜错会静默放过冲突。
 */
export function repoInfo(cwd = process.cwd()): RepoInfo {
  const laneTop = git(['rev-parse', '--show-toplevel'], cwd);
  const commonDir = path.resolve(
    cwd,
    git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
  );
  if (!existsSync(commonDir)) {
    throw new CoworkError(
      EXIT.ENV,
      `共享 git 目录不存在: ${commonDir}`,
      'cowork 需要常规非裸仓库；如果是 worktree，请确认 .git 文件指向正确。',
    );
  }
  const mainRoot = path.dirname(commonDir);
  if (!existsSync(mainRoot)) {
    throw new CoworkError(
      EXIT.ENV,
      `无法定位主仓库根: ${mainRoot}`,
      'cowork 需要常规非裸仓库（共享 git 目录应是 <repo>/.git）。',
    );
  }
  return { laneTop, commonDir, mainRoot, laneName: laneNameOf(mainRoot, laneTop) };
}

export function currentBranch(cwd = process.cwd()): string | null {
  const name = gitTry(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
  return name === null || name === '' ? null : name;
}

export function headCommit(cwd = process.cwd()): string | null {
  return gitTry(['rev-parse', '--short', 'HEAD'], cwd);
}
