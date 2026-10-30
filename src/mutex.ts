import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
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
  staleMs?: number;
  /** 等待期间回调，用于给用户一个"在等谁"的提示。 */
  onWait?: (owner: LockOwner | null) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;

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
    throw new CoworkError(EXIT.ENV, `无法创建锁目录 ${lockDir}: ${code ?? String(err)}`, '检查磁盘权限与路径长度。');
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
    throw new CoworkError(EXIT.ENV, `无法写入 owner.json: ${String(err)}`, '检查磁盘权限。');
  }
  return owner;
}

function isStale(lockDir: string, owner: LockOwner | null, staleMs: number): boolean {
  const now = Date.now();
  if (owner === null) {
    // 目录已建但 owner.json 还没写：可能是刚抢到锁的瞬间，也可能是崩溃。
    try {
      const age = now - statSync(lockDir).mtimeMs;
      return age > 5_000;
    } catch {
      return false;
    }
  }
  if (owner.host !== hostname()) return false; // 跨机器不做活体判断，交给 timeout
  if (!pidAlive(owner.pid)) return true;
  const acquired = Date.parse(owner.acquiredAt);
  if (Number.isFinite(acquired) && now - acquired > staleMs) return true;
  return false;
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
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  if (held.has(lockDir)) {
    throw new CoworkError(
      EXIT.GENERAL,
      '内部错误：在已持锁的临界区内再次加锁',
      '这是 bug，请报告；不要把需要加锁的操作嵌套进另一个加锁回调。',
    );
  }

  mkdirSync(stateRoot, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let notified = false;

  for (;;) {
    const owner = tryAcquire(lockDir);
    if (owner !== null) {
      held.add(lockDir);
      try {
        return await fn();
      } finally {
        held.delete(lockDir);
        rmSync(lockDir, { recursive: true, force: true });
      }
    }

    const current = readOwner(lockDir);
    if (isStale(lockDir, current, staleMs)) {
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
