import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { doctorFix } from '../src/claims.ts';
import { CoworkError, EXIT } from '../src/errors.ts';
import type { RepoInfo } from '../src/git.ts';
import {
  claimFilePath,
  ensureState,
  listClaims,
  quarantineClaim,
  readClaim,
  stateRoot,
  writeClaim,
  type ClaimRecord,
} from '../src/store.ts';

const roots: string[] = [];

interface Fixture {
  root: string;
  info: RepoInfo;
  state: string;
}

function freshFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-store-'));
  roots.push(root);
  const info: RepoInfo = {
    laneTop: root,
    commonDir: path.join(root, '.git'),
    mainRoot: root,
    laneName: null,
  };
  const state = stateRoot(info);
  ensureState(state);
  return { root, info, state };
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function record(root: string, overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: 'abc123',
    kind: 'file',
    key: 'src/a.ts',
    display: 'src/a.ts',
    lane: null,
    lanePath: root,
    branch: 'main',
    agentId: 'dsh',
    pid: 1234,
    host: 'host',
    note: null,
    createdAt: new Date().toISOString(),
    ttlMs: 3_600_000,
    ...overrides,
  };
}

function expectGeneral(fn: () => unknown): CoworkError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CoworkError, `expected CoworkError, got ${String(err)}`);
    assert.equal(err.code, EXIT.GENERAL);
    assert.ok(err.message.includes('状态文件损坏'), err.message);
    assert.ok(err.hint?.includes('doctor --fix'), 'hint 应说明怎么修');
    return err;
  }
  assert.fail('expected a CoworkError');
}

test('损坏的 claim JSON 读取时 fail closed，不返回 null', () => {
  const { root, state } = freshFixture();
  writeFileSync(claimFilePath(state, 'bad'), '{ not json', 'utf8');

  expectGeneral(() => readClaim(state, 'bad'));
  expectGeneral(() => listClaims(state));
  assert.ok(root.length > 0);
});

test('字段类型不对同样按损坏处理（pid/agent/host 会被渲染到面板）', () => {
  const { root, state } = freshFixture();
  for (const [id, patch] of [
    ['bad-pid', { pid: '1234' }],
    ['bad-agent', { agentId: 42 }],
    ['bad-host', { host: null }],
    ['bad-kind', { kind: 'glob' }],
  ] as const) {
    writeClaim(state, record(root, { id, ...(patch as Partial<ClaimRecord>) }));
    expectGeneral(() => readClaim(state, id));
  }
});

test('doctor --fix 把损坏文件移进 trash 并报告，而不是跳过', async () => {
  const { root, info, state } = freshFixture();
  writeFileSync(claimFilePath(state, 'bad'), '{ not json', 'utf8');
  writeClaim(state, record(root, { id: 'good' }));

  const report = await doctorFix(info);
  assert.equal(report.quarantined.length, 1);
  const item = report.quarantined[0];
  assert.ok(item !== undefined);
  assert.ok(item.reason.includes('状态文件损坏'));
  assert.ok(item.trash !== null && existsSync(item.trash), '坏文件应被移到 trash');
  assert.equal(existsSync(claimFilePath(state, 'bad')), false);
  assert.deepEqual(
    listClaims(state).map((rec) => rec.id),
    ['good'],
    '好文件应保留',
  );
});

test('过期的有效 claim 仍然被清理，未过期的保留', async () => {
  const { root, info, state } = freshFixture();
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  writeClaim(state, record(root, { id: 'old', createdAt: expiredAt, ttlMs: 1_000 }));
  writeClaim(state, record(root, { id: 'fresh' }));

  const report = await doctorFix(info);
  assert.deepEqual(
    report.pruned.map((rec) => rec.id),
    ['old'],
  );
  assert.equal(report.quarantined.length, 0);
  assert.deepEqual(
    listClaims(state).map((rec) => rec.id),
    ['fresh'],
  );
});

test('quarantineClaim 对不存在的 id 返回 null', () => {
  const { state } = freshFixture();
  assert.equal(quarantineClaim(state, 'missing'), null);
});
