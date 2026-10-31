import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError } from '../src/errors.ts';
import {
  listTaskLive,
  listTaskLiveStates,
  markCorrupt,
  readTaskLive,
  taskLiveFile,
  transitionM2Task,
  transitionTask,
  writeTaskLive,
} from '../src/taskstore.ts';
import { removeTree } from './helpers.ts';

const ID = 't-3f9a1c';

function makeState(): { root: string; state: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-live-'));
  const state = path.join(root, 'cowork');
  mkdirSync(state, { recursive: true });
  return { root, state, cleanup: () => removeTree(root) };
}

test('transitionTask 从缺失状态按 draft 起算并追加 history', () => {
  const fixture = makeState();
  try {
    const live = transitionTask(fixture.state, ID, 'ready', {
      agent: 'dsh',
      note: '规格已合并',
    });
    assert.equal(live.status, 'ready');
    assert.equal(live.history.length, 1);
    assert.equal(live.history[0]?.from, 'draft');
    assert.equal(live.history[0]?.to, 'ready');
    assert.equal(live.history[0]?.agent, 'dsh');
    assert.equal(live.created_at, live.updated_at);

    const claimed = transitionTask(fixture.state, ID, 'claimed', {
      lane: 'dsh-m0',
      lanePath: 'D:/repo/.cowork/lanes/dsh-m0',
      agent: 'dsh',
      specCommit: 'a'.repeat(40),
    });
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.lane, 'dsh-m0');
    assert.equal(claimed.spec_commit, 'a'.repeat(40));
    assert.equal(claimed.history.length, 2);
    const reread = readTaskLive(fixture.state, ID);
    assert.deepEqual(reread, claimed);
  } finally {
    fixture.cleanup();
  }
});

test('M2 状态与 verification live 记录可读写，普通 M1 转移入口仍隔离', () => {
  const fixture = makeState();
  try {
    transitionTask(fixture.state, ID, 'ready');
    transitionTask(fixture.state, ID, 'claimed', { lane: 'dsh-m2', lanePath: 'D:/repo/.cowork/lanes/dsh-m2', agent: 'dsh' });
    transitionTask(fixture.state, ID, 'in_progress');
    transitionTask(fixture.state, ID, 'reported_done');
    const started = transitionM2Task(fixture.state, ID, 'verifying', {
      verification: {
        run_id: 'verify-1', status: 'running', pid: null, host: null,
        pid_started_at: null, pid_start_error: null, started_at: '2026-11-01T00:00:00.000Z',
        finished_at: null, head_before: 'a'.repeat(40), head_after: null,
        config_commit: 'b'.repeat(40), summary: '', records: [],
      },
    });
    assert.equal(started.status, 'verifying');
    assert.equal(readTaskLive(fixture.state, ID)?.verification?.config_commit, 'b'.repeat(40));
    assert.throws(() => transitionM2Task(fixture.state, ID, 'merged'), /非法 M2 状态转换/);
    const failed = transitionM2Task(fixture.state, ID, 'verify_failed', {
      verification: { ...started.verification!, status: 'failed', finished_at: '2026-11-01T00:00:01.000Z' },
    });
    assert.equal(failed.status, 'verify_failed');
    assert.deepEqual(readTaskLive(fixture.state, ID), failed);
    const blocked = transitionM2Task(fixture.state, ID, 'blocked', { agent: 'dsh', reason: '等待外部确认' });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blocked_reason, '等待外部确认');
    const ready = transitionTask(fixture.state, ID, 'ready', { agent: null, lane: null, lanePath: null });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.lane, null);
  } finally {
    fixture.cleanup();
  }
});

test('blocked 必须带 reason，in_progress 会清掉 blocked_reason', () => {
  const fixture = makeState();
  try {
    transitionTask(fixture.state, ID, 'ready');
    transitionTask(fixture.state, ID, 'claimed', { lane: 'dsh-m0' });
    assert.throws(
      () => transitionTask(fixture.state, ID, 'blocked'),
      /blocked 必须带 --reason/,
    );
    const blocked = transitionTask(fixture.state, ID, 'blocked', { reason: '等 Codex 合入接口' });
    assert.equal(blocked.blocked_reason, '等 Codex 合入接口');
    const resumed = transitionTask(fixture.state, ID, 'in_progress');
    assert.equal(resumed.blocked_reason, null);
  } finally {
    fixture.cleanup();
  }
});

test('非法转换直接报错，不写 live', () => {
  const fixture = makeState();
  try {
    transitionTask(fixture.state, ID, 'ready');
    assert.throws(() => transitionTask(fixture.state, ID, 'merged'), /非法状态转换: ready → merged/);
    const live = readTaskLive(fixture.state, ID);
    assert.equal(live?.status, 'ready');
    assert.equal(live?.history.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('写入是原子的：不留 tmp 文件', () => {
  const fixture = makeState();
  try {
    transitionTask(fixture.state, ID, 'ready');
    const files = readdirSync(path.join(fixture.state, 'tasks'));
    assert.deepEqual(files, [`${ID}.json`]);
    const raw = JSON.parse(readFileSync(taskLiveFile(fixture.state, ID), 'utf8')) as {
      status?: string;
    };
    assert.equal(raw.status, 'ready');
  } finally {
    fixture.cleanup();
  }
});

test('坏 live 文件让读取类命令 exit 1，并提示 doctor --fix', () => {
  const fixture = makeState();
  try {
    mkdirSync(path.join(fixture.state, 'tasks'), { recursive: true });
    writeFileSync(taskLiveFile(fixture.state, ID), '{ broken', 'utf8');
    assert.throws(() => readTaskLive(fixture.state, ID), /任务状态文件损坏/);
    assert.throws(
      () => readTaskLive(fixture.state, ID),
      (err: unknown) =>
        err instanceof CoworkError &&
        err.hint !== undefined &&
        /doctor --fix/.test(err.hint),
    );
    assert.throws(() => listTaskLive(fixture.state), /任务状态文件损坏/);
    const { lives, corrupt } = listTaskLiveStates(fixture.state);
    assert.equal(lives.length, 0);
    assert.equal(corrupt.length, 1);
    assert.equal(corrupt[0]?.id, ID);
    assert.match(corrupt[0]?.error ?? '', /任务状态文件损坏/);
  } finally {
    fixture.cleanup();
  }
});

test('status 或字段类型不对也算损坏', () => {
  const fixture = makeState();
  try {
    const live = transitionTask(fixture.state, ID, 'ready');
    writeTaskLive(fixture.state, { ...live, status: 'sleeping' as never });
    assert.throws(() => readTaskLive(fixture.state, ID), /status 不是合法状态/);
    writeTaskLive(fixture.state, live);
    writeTaskLive(fixture.state, { ...live, lane: 42 as never });
    assert.throws(() => readTaskLive(fixture.state, ID), /lane 必须是字符串或 null/);
  } finally {
    fixture.cleanup();
  }
});

test('markCorrupt 保留已知字段，且 corrupt 任务拒绝继续操作', () => {
  const fixture = makeState();
  try {
    transitionTask(fixture.state, ID, 'ready');
    transitionTask(fixture.state, ID, 'claimed', { lane: 'dsh-m0', lanePath: 'D:/w' });
    const corrupt = markCorrupt(fixture.state, ID, '回滚 claims 失败');
    assert.equal(corrupt.status, 'corrupt');
    assert.equal(corrupt.lane, 'dsh-m0');
    assert.equal(corrupt.blocked_reason, '回滚 claims 失败');
    assert.equal(corrupt.history.at(-1)?.to, 'corrupt');
    assert.throws(
      () => transitionTask(fixture.state, ID, 'in_progress'),
      /任务处于 corrupt 状态/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('listTaskLive 按 id 排序并忽略无关文件', () => {
  const fixture = makeState();
  try {
    const dir = path.join(fixture.state, 'tasks');
    mkdirSync(dir, { recursive: true });
    for (const id of ['t-bbbbbb', 't-aaaaaa']) {
      transitionTask(fixture.state, id, 'ready');
    }
    writeFileSync(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');
    const ids = listTaskLive(fixture.state).map((live) => live.id);
    assert.deepEqual(ids, ['t-aaaaaa', 't-bbbbbb']);
  } finally {
    fixture.cleanup();
  }
});
