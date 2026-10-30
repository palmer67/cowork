import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { CoworkError, EXIT, busy } from './errors.ts';

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

export interface LockOptions {
  timeoutMs?: number;
  /** 等待期间回调，用于给用户一个"在等谁"的提示。 */
  onWait?: (owner: LockOwner | null) => void;
  /**
   * false 表示只读调用：stateRoot 不存在时直接执行 fn，不为了看一眼把它建出来。
   * 写命令永远用默认 true（先 ensureState 再进来）。
   */
  createStateDir?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 同一进程内已持有的锁目录：重复加锁会自锁死，直接报错。 */
const held = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但没有权限发信号。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    const raw = readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : 'unknown',
      token: parsed.token,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
    };
  } catch {
    return null;
  }
}

function tryAcquire(lockDir: string): LockOwner | null {
  try {
    mkdirSync(lockDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw new CoworkError(
      EXIT.GENERAL,
      `无法创建锁目录 ${lockDir}: ${code ?? String(err)}`,
      '检查状态目录是否可写、父路径是否是目录；修好后再重试。',
    );
  }
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    acquiredAt: new Date().toISOString(),
  };
  try {
    writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
  } catch (err) {
    rmSync(lockDir, { recursive: true, force: true });
    throw new CoworkError(
      EXIT.GENERAL,
      `无法写入 owner.json: ${String(err)}`,
      '检查状态目录的磁盘权限与剩余空间。',
    );
  }
  return owner;
}

function isStale(lockDir: string, owner: LockOwner | null): boolean {
  if (owner === null) {
    // 目录已建但 owner.json 还没写：可能是刚抢到锁的瞬间，也可能是崩溃。
    try {
      return Date.now() - statSync(lockDir).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  if (owner.host !== hostname()) return false; // 跨机器不做活体判断，交给 timeout
  // 只按"进程是否还活着"回收：锁龄长不代表持有者死了。长操作（比如一条很慢的命令）
  // 如果被按时间抢走锁，原持有者收尾时还会删掉新锁，等于没有互斥。
  return !pidAlive(owner.pid);
}

/** 把残留锁挪到 trash，避免直接删除时与别人竞争。 */
function reap(lockDir: string, stateRoot: string): void {
  const trash = path.join(stateRoot, 'trash');
  mkdirSync(trash, { recursive: true });
  const target = path.join(trash, `lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    renameSync(lockDir, target);
  } catch {
    return; // 别人已经清掉了
  }
  rmSync(target, { recursive: true, force: true });
}

function describe(owner: LockOwner | null): string {
  if (owner === null) return '一个未知进程（owner.json 缺失）';
  return `pid ${owner.pid}@${owner.host}（${owner.acquiredAt}）`;
}

/**
 * 释放锁前核对 token：如果锁已被回收并被别人重建，旧持有者绝不能删掉新锁。
 * 这种情况说明本次临界区并没有独占，必须显式说出来，而不是假装正常结束。
 */
function releaseLock(lockDir: string, own: LockOwner): void {
  const current = readOwner(lockDir);
  if (current !== null && current.token === own.token) {
    rmSync(lockDir, { recursive: true, force: true });
    return;
  }
  console.warn(
    `cowork: 锁已被回收，本次未独占: ${lockDir}（当前持有者: ${describe(current)}）。未删除他人锁。`,
  );
}

/**
 * 全局互斥。临界区必须短：不得在里面跑 git、测试或遍历文件树。
 * 拿不到锁时退出 2，并说明占用者与解决方式。
 */
export async function withLock<T>(
  stateRoot: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const lockDir = path.join(stateRoot, 'lock');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (held.has(lockDir)) {
    throw new CoworkError(
      EXIT.GENERAL,
      '内部错误：在已持锁的临界区内再次加锁',
      '这是 bug，请报告；不要把需要加锁的操作嵌套进另一个加锁回调。',
    );
  }

  if (options.createStateDir === false && !existsSync(stateRoot)) {
    // 只读调用（比如 snapshot）：还没有 live 状态目录，就说明还没有 writer 需要持锁。
    // 为了看一眼而把 <common>/cowork 建出来属于写入副作用，这里直接执行回调。
    return await fn();
  }
  try {
    mkdirSync(stateRoot, { recursive: true });
  } catch (err) {
    throw new CoworkError(
      EXIT.GENERAL,
      `无法创建状态目录 ${stateRoot}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
      '检查 .git 目录的权限与父路径；修好后运行 cowork doctor --fix。',
    );
  }  const deadline = Date.now() + timeoutMs;
  let notified = false;

  for (;;) {
    const owner = tryAcquire(lockDir);
    if (owner !== null) {
      held.add(lockDir);
      try {
        return await fn();
      } finally {
        held.delete(lockDir);
        releaseLock(lockDir, owner);
      }
    }

    const current = readOwner(lockDir);
    if (isStale(lockDir, current)) {
      reap(lockDir, stateRoot);
      continue;
    }

    if (Date.now() > deadline) {
      throw busy(
        `状态锁被占用: ${describe(current)}`,
        `已等待 ${timeoutMs}ms。先运行 cowork status 看谁在动作；若确信是残留锁，运行 cowork doctor --fix。`,
      );
    }
    if (!notified) {
      notified = true;
      options.onWait?.(current);
    }
    await sleep(5 + Math.floor(Math.random() * 10));
  }
}
