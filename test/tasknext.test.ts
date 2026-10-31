import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError, EXIT } from '../src/errors.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { claimTtlMs } from '../src/claims.ts';
import { parseClaim } from '../src/paths.ts';
import {
  claimId,
  ensureState,
  listClaims,
  readClaim,
  removeClaim,
  stateRoot,
  writeClaim,
  type ClaimRecord,
} from '../src/store.ts';
import { readTaskLive, transitionM2Task, transitionTask } from '../src/taskstore.ts';
import { readTrunkCatalog } from '../src/tasks.ts';
import { intentFile, listIntents, next, recoverIntents, writeIntent, type NextIntent } from '../src/tasknext.ts';
import { removeTree } from './helpers.ts';

interface Fixture {
  root: string;
  info: RepoInfo;
  state: string;
  cleanup: () => void;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function specText(meta: Record<string, unknown>): string {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n## 背景\n\n测试任务。\n`;
}

function specMeta(id: string, title: string, touches: string[], created: string, depends: string[] = []): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    title,
    touches,
    reads: [],
    depends_on: depends,
    done_when: ['npm test'],
    contracts: [],
    created_at: created,
  };
}

const ALPHA = specMeta('t-00a1b2', 'alpha', ['src/alpha/**'], '2026-10-30T10:00:00.000Z');
const BETA = specMeta('t-00b3c4', 'beta', ['src/beta/**'], '2026-10-30T11:00:00.000Z');
const GAMMA = specMeta('t-00c5d6', 'gamma', ['src/alpha/shared.ts'], '2026-10-30T12:00:00.000Z');

function makeRepo(specs: Record<string, unknown>[]): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-next-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'test'], root);
  writeFileSync(path.join(root, 'README.md'), '# test\n', 'utf8');
  mkdirSync(path.join(root, '.cowork'), { recursive: true });
  writeFileSync(
    path.join(root, '.cowork', 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, trunk: 'main' }, null, 2)}\n`,
    'utf8',
  );
  mkdirSync(path.join(root, '.cowork', 'tasks'), { recursive: true });
  for (const meta of specs) {
    writeFileSync(path.join(root, '.cowork', 'tasks', `${String(meta['id'])}.md`), specText(meta), 'utf8');
  }
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);
  const info = repoInfo(root);
  return {
    root,
    info,
    state: stateRoot(info),
    cleanup: () => removeTree(root),
  };
}

function markReady(fixture: Fixture, ids: readonly string[]): void {
  ensureState(fixture.state);
  for (const id of ids) transitionTask(fixture.state, id, 'ready');
}

function makeRecord(fixture: Fixture, display: string, agent: string): ClaimRecord {
  const claimPath = parseClaim(display, fixture.info);
  return {
    id: claimId(claimPath),
    kind: claimPath.kind,
    key: claimPath.key,
    display,
    lane: null,
    lanePath: fixture.info.laneTop,
    branch: 'main',
    agentId: agent,
    pid: process.pid,
    host: hostname(),
    note: 'test',
    createdAt: new Date().toISOString(),
    ttlMs: claimTtlMs(),
  };
}

async function expectCode(fn: () => Promise<unknown>, code: number): Promise<CoworkError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CoworkError, `expected CoworkError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected CoworkError with code ${code}`);
}

test('next 领取最早 ready 任务，写 live 与 claims，不留 intent', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const result = await next(fixture.info, { agent: 'dsh' });
    assert.equal(result.task.id, 't-00a1b2');
    assert.equal(result.live.status, 'claimed');
    assert.equal(result.live.agent, 'dsh');
    assert.equal(result.live.lane, null);
    assert.equal(result.live.lanePath, fixture.info.laneTop);
    assert.equal(result.live.spec_commit, result.specCommit);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]?.display, 'src/alpha/**');
    assert.equal(result.claims[0]?.note, 'task t-00a1b2');
    assert.equal(result.claims[0]?.agentId, 'dsh');
    assert.deepEqual(result.recovery, { recovered: [], cleaned: [], corrupt: [] });
    assert.deepEqual(listIntents(fixture.state), []);
    const claims = listClaims(fixture.state);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.display, 'src/alpha/**');
  } finally {
    fixture.cleanup();
  }
});

test('第二次 next 跳过已领取任务，按 created_at 取下一个', async () => {
  const fixture = makeRepo([BETA, ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2', 't-00b3c4']);
    const first = await next(fixture.info, { agent: 'dsh' });
    const second = await next(fixture.info, { agent: 'dsh' });
    assert.equal(first.task.id, 't-00a1b2');
    assert.equal(second.task.id, 't-00b3c4');
    assert.deepEqual(
      listClaims(fixture.state).map((record) => record.display).sort(),
      ['src/alpha/**', 'src/beta/**'],
    );
    assert.deepEqual(listIntents(fixture.state), []);
  } finally {
    fixture.cleanup();
  }
});

test('依赖尚未 merged 时退出 1，并说明在等哪个依赖', async () => {
  const dep = specMeta('t-00d7e8', 'dep', ['src/dep/**'], '2026-10-30T09:00:00.000Z');
  const child = specMeta('t-00e9f0', 'child', ['src/child/**'], '2026-10-30T10:00:00.000Z', ['t-00d7e8']);
  const fixture = makeRepo([dep, child]);
  try {
    markReady(fixture, ['t-00e9f0']);
    const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
    assert.match(err.message, /尚未 merged/);
    assert.match(err.message, /t-00d7e8/);
    assert.equal(readTaskLive(fixture.state, 't-00e9f0')?.status, 'ready');
  } finally {
    fixture.cleanup();
  }
});

test('touches 被别人的 claim 占着时退出 1，并指出占用者', async () => {
  const fixture = makeRepo([BETA]);
  try {
    markReady(fixture, ['t-00b3c4']);
    ensureState(fixture.state);
    writeClaim(fixture.state, makeRecord(fixture, 'src/beta/**', 'codex'));
    const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
    assert.match(err.message, /src\/beta\/\*\*/);
    assert.match(err.message, /codex/);
    assert.equal(readTaskLive(fixture.state, 't-00b3c4')?.status, 'ready');
  } finally {
    fixture.cleanup();
  }
});

test('touches 与另一任务的 held lease 重叠时退出 1', async () => {
  const fixture = makeRepo([ALPHA, GAMMA]);
  try {
    markReady(fixture, ['t-00a1b2', 't-00c5d6']);
    const catalog = readTrunkCatalog(fixture.info);
    ensureState(fixture.state);
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      agent: 'codex',
      lane: null,
      lanePath: fixture.info.laneTop,
      specCommit: catalog.rev,
    });
    const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
    assert.match(err.message, /t-00c5d6/);
    assert.match(err.message, /重叠/);
  } finally {
    fixture.cleanup();
  }
});

test('verifying、verify_failed、awaiting_merge 的 held lease 仍阻止同路径领取', async () => {
  for (const status of ['verifying', 'verify_failed', 'awaiting_merge'] as const) {
    const fixture = makeRepo([ALPHA, GAMMA]);
    try {
      markReady(fixture, ['t-00a1b2', 't-00c5d6']);
      const acquired = await next(fixture.info, { agent: 'codex' });
      assert.equal(acquired.task.id, 't-00a1b2');
      removeClaim(fixture.state, claimId(parseClaim('src/alpha/**', fixture.info)));
      transitionTask(fixture.state, 't-00a1b2', 'in_progress', { agent: 'codex' });
      transitionTask(fixture.state, 't-00a1b2', 'reported_done', { agent: 'codex' });
      if (status === 'verifying') {
        transitionM2Task(fixture.state, 't-00a1b2', 'verifying', { agent: 'codex' });
      } else {
        transitionM2Task(fixture.state, 't-00a1b2', 'verifying', { agent: 'codex' });
        transitionM2Task(fixture.state, 't-00a1b2', status, { agent: 'codex' });
      }
      const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
      assert.match(err.message, /t-00a1b2/);
      assert.match(err.message, /重叠/);
    } finally {
      fixture.cleanup();
    }
  }
});

test('半成品 pending intent 会先回滚，任务可再次领取', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const catalog = readTrunkCatalog(fixture.info);
    const ready = readTaskLive(fixture.state, 't-00a1b2');
    assert.ok(ready !== null);
    // 模拟 next 在写 claim 之后、写 committed 之前崩溃。
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      agent: 'dsh',
      lane: null,
      lanePath: fixture.info.laneTop,
      specCommit: catalog.rev,
    });
    const record = { ...makeRecord(fixture, 'src/alpha/**', 'dsh'), note: 'task t-00a1b2' };
    writeClaim(fixture.state, record);
    const intent: NextIntent = {
      schemaVersion: 1,
      operation_id: 't-00a1b2-crashed',
      task_id: 't-00a1b2',
      lane: null,
      lane_path: fixture.info.laneTop,
      agent: 'dsh',
      branch: 'main',
      prev: ready,
      claim_ids: [record.id],
      phase: 'pending',
      created_at: new Date().toISOString(),
    };
    writeIntent(fixture.state, intent);

    const result = await next(fixture.info, { agent: 'dsh' });
    assert.equal(result.task.id, 't-00a1b2');
    assert.deepEqual(result.recovery.recovered, ['t-00a1b2']);
    assert.equal(readTaskLive(fixture.state, 't-00a1b2')?.status, 'claimed');
    assert.deepEqual(listIntents(fixture.state), []);
    assert.equal(listClaims(fixture.state)[0]?.note, 'task t-00a1b2');
    assert.equal(readClaim(fixture.state, record.id)?.createdAt !== record.createdAt, true);
  } finally {
    fixture.cleanup();
  }
});

test('committed intent 缺少 claim 时标记 corrupt 并拒绝继续', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const catalog = readTrunkCatalog(fixture.info);
    const ready = readTaskLive(fixture.state, 't-00a1b2');
    assert.ok(ready !== null);
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      agent: 'dsh',
      lane: null,
      lanePath: fixture.info.laneTop,
      specCommit: catalog.rev,
    });
    const missing = makeRecord(fixture, 'src/beta/**', 'dsh').id;
    writeIntent(fixture.state, {
      schemaVersion: 1,
      operation_id: 't-00a1b2-committed',
      task_id: 't-00a1b2',
      lane: null,
      lane_path: fixture.info.laneTop,
      agent: 'dsh',
      branch: 'main',
      prev: ready,
      claim_ids: [missing],
      phase: 'committed',
      created_at: new Date().toISOString(),
    });

    const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
    assert.match(err.message, /corrupt/);
    assert.equal(readTaskLive(fixture.state, 't-00a1b2')?.status, 'corrupt');
    assert.match(readTaskLive(fixture.state, 't-00a1b2')?.blocked_reason ?? '', /缺少 claim|恢复 next 事务失败/);
  } finally {
    fixture.cleanup();
  }
});

test('intent 文件损坏时拒绝继续，且不改动 live', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const file = intentFile(fixture.state, 'broken');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{not json', 'utf8');
    const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
    assert.match(err.message, /intent 损坏/);
    assert.equal(readTaskLive(fixture.state, 't-00a1b2')?.status, 'ready');
  } finally {
    fixture.cleanup();
  }
});

test('tasks 目录读不出来时 fail closed，不把任务当空集', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const tasksDir = path.join(fixture.state, 'tasks');
    rmSync(tasksDir, { recursive: true, force: true });
    writeFileSync(tasksDir, 'not a directory', 'utf8');
    const err = await expectCode(() => next(fixture.info, { agent: 'dsh' }), EXIT.GENERAL);
    assert.match(err.message, /任务状态不可读/);
  } finally {
    fixture.cleanup();
  }
});

test('committed intent 对应已 merged 的任务时，清掉残留 claim 再删 intent', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const catalog = readTrunkCatalog(fixture.info);
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      agent: 'dsh',
      lane: null,
      lanePath: fixture.info.laneTop,
      specCommit: catalog.rev,
    });
    transitionTask(fixture.state, 't-00a1b2', 'in_progress', { agent: 'dsh' });
    transitionTask(fixture.state, 't-00a1b2', 'reported_done', { agent: 'dsh' });
    transitionTask(fixture.state, 't-00a1b2', 'merged', { lane: null, lanePath: null, agent: null });

    const record = { ...makeRecord(fixture, 'src/alpha/**', 'dsh'), note: 'task t-00a1b2' };
    writeClaim(fixture.state, record);
    writeIntent(fixture.state, {
      schemaVersion: 1,
      operation_id: 't-00a1b2-merged-leftover',
      task_id: 't-00a1b2',
      lane: null,
      lane_path: fixture.info.laneTop,
      agent: 'dsh',
      branch: 'main',
      prev: null,
      claim_ids: [record.id],
      phase: 'committed',
      created_at: new Date().toISOString(),
    });

    const report = recoverIntents(fixture.state);
    assert.deepEqual(report.cleaned, ['t-00a1b2']);
    assert.equal(readClaim(fixture.state, record.id), null, '残留 claim 应被清掉');
    assert.deepEqual(listIntents(fixture.state), []);
  } finally {
    fixture.cleanup();
  }
});

test('回滚 pending intent 时，不删 note 不属于本任务的 claim', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const ready = readTaskLive(fixture.state, 't-00a1b2');
    assert.ok(ready !== null);
    const record = { ...makeRecord(fixture, 'src/alpha/**', 'dsh'), note: 'task t-00b3c4' };
    writeClaim(fixture.state, record);
    writeIntent(fixture.state, {
      schemaVersion: 1,
      operation_id: 't-00a1b2-pending-foreign',
      task_id: 't-00a1b2',
      lane: null,
      lane_path: fixture.info.laneTop,
      agent: 'dsh',
      branch: 'main',
      prev: ready,
      claim_ids: [record.id],
      phase: 'pending',
      created_at: new Date().toISOString(),
    });

    const report = recoverIntents(fixture.state);
    assert.deepEqual(report.recovered, ['t-00a1b2']);
    assert.ok(readClaim(fixture.state, record.id) !== null, '不属于本任务的 claim 不能被回滚删除');
    assert.equal(readTaskLive(fixture.state, 't-00a1b2')?.status, 'ready');
  } finally {
    fixture.cleanup();
  }
});
