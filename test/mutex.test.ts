import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { CoworkError, EXIT } from '../src/errors.ts';
import { withLock, type LockOwner } from '../src/mutex.ts';

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cowork-mutex-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function writeOwner(
  state: string,
  fields: Partial<LockOwner> & Pick<LockOwner, 'token'>,
): string {
  const lockDir = path.join(state, 'lock');
  mkdirSync(lockDir, { recursive: true });
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...fields,
  };
  const file = path.join(lockDir, 'owner.json');
  writeFileSync(file, JSON.stringify(owner), 'utf8');
  return lockDir;
}

async function expectCode(fn: () => Promise<unknown>, code: number): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof CoworkError, `expected CoworkError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

test('活着的持有者即使锁龄远超旧阈值也不会被回收', async () => {
  const state = freshRoot();
  writeOwner(state, {
    token: 'live',
    acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
  });

  await expectCode(() => withLock(state, () => 'ok', { timeoutMs: 120 }), EXIT.BUSY);

  const owner = JSON.parse(readFileSync(path.join(state, 'lock', 'owner.json'), 'utf8')) as LockOwner;
  assert.equal(owner.token, 'live', '长操作期间锁不能被别人按时间抢走');
});

test('锁被回收重建后，旧持有者不删新锁并明确说明未独占', async () => {
  const state = freshRoot();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const result = await withLock(state, () => {
      const lockDir = path.join(state, 'lock');
      rmSync(lockDir, { recursive: true, force: true });
      writeOwner(state, { token: 'new-owner' });
      return 'done';
    });
    assert.equal(result, 'done');
  } finally {
    console.warn = original;
  }

  const owner = JSON.parse(readFileSync(path.join(state, 'lock', 'owner.json'), 'utf8')) as LockOwner;
  assert.equal(owner.token, 'new-owner', '新锁必须还在');
  assert.ok(
    warnings.some((line) => line.includes('未独占')),
    `应警告本次未独占，实际: ${warnings.join(' | ')}`,
  );
});

test('owner.json 损坏：新鲜时视为占用，超过 5 秒按崩溃回收', async () => {
  const state = freshRoot();
  const lockDir = path.join(state, 'lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner.json'), '{ this is not json', 'utf8');

  await expectCode(() => withLock(state, () => 'ok', { timeoutMs: 120 }), EXIT.BUSY);
  assert.ok(existsSync(lockDir), '新鲜坏锁不应被立即清理');

  const past = new Date(Date.now() - 10_000);
  utimesSync(lockDir, past, past);
  assert.equal(await withLock(state, () => 'acquired'), 'acquired');
  assert.equal(existsSync(path.join(lockDir, 'owner.json')), false, '正常释放后不留锁');
});

test('锁目录创建失败按 IO 错误退出 1，而不是环境错误 3', async () => {
  const parent = freshRoot();
  const stateAsFile = path.join(parent, 'state');
  writeFileSync(stateAsFile, 'not a directory', 'utf8');

  await expectCode(() => withLock(stateAsFile, () => 'ok'), EXIT.GENERAL);
});

test('正常加锁/释放不残留锁目录', async () => {
  const state = freshRoot();
  assert.equal(await withLock(state, () => 42), 42);
  assert.equal(existsSync(path.join(state, 'lock')), false);
  assert.equal(await withLock(state, () => 43), 43);
});

test('createStateDir=false 的只读调用不创建状态目录', async () => {
  const parent = freshRoot();
  const state = path.join(parent, 'cowork');
  const result = await withLock(state, () => 'read-only', { createStateDir: false });
  assert.equal(result, 'read-only');
  assert.equal(existsSync(state), false, '只读快照不能为了读 claims 建出 live 目录');
});

test('createStateDir 默认行为仍是先建状态目录再加锁', async () => {
  const parent = freshRoot();
  const state = path.join(parent, 'cowork');
  assert.equal(await withLock(state, () => existsSync(path.join(state, 'lock'))), true);
  assert.equal(existsSync(state), true);
});
