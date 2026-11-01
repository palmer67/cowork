import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dashboard, renderDashboard } from '../src/dashboard.ts';
import { status } from '../src/claims.ts';
import { snapshot } from '../src/snapshot.ts';
import { writeTaskLive, type TaskLive, type VerificationLive } from '../src/taskstore.ts';
import { cw, git, lane, makeRepo } from './m3-helpers.ts';

function addLive(root: string, state: string, id: string, status: TaskLive['status']): void {
  const at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const dir = path.join(root, '.cowork', 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.md`), `---\n${JSON.stringify({
    schemaVersion: 1, id, title: `task ${id}`, touches: [`src/${id}.ts`], reads: [],
    depends_on: [], done_when: [], contracts: [], created_at: at,
  })}\n---\n`);
  git(['add', '.cowork/tasks'], root); git(['commit', '-qm', id], root);
  const head = git(['rev-parse', 'HEAD'], root);
  const verification: VerificationLive | null = ['verifying', 'verify_failed', 'awaiting_merge'].includes(status) ? {
    run_id: `verify-${id}`, status: status === 'verifying' ? 'running' : status === 'verify_failed' ? 'failed' : 'passed',
    pid: process.pid, host: hostname(), pid_started_at: null, pid_start_error: null,
    started_at: at, finished_at: null, head_before: head, head_after: null, config_commit: head,
    summary: `失败\n${'长摘要'.repeat(50)}`, records: [],
  } : null;
  writeTaskLive(state, {
    schemaVersion: 1, id, status, agent: 'owner', lane: null, lanePath: root,
    spec_commit: head, created_at: at, updated_at: at, blocked_reason: null, verification, recovery: null,
    history: [{ at, from: 'in_progress', to: status, agent: 'owner', note: 'test fixture' }],
  });
}

test('status presents four sections, JSON, trunk lag, dirty counts and verification details', async () => {
  const fixture = makeRepo();
  try {
    const dir = lane(fixture.root, 'alpha');
    for (const [id, value] of [['t-000001', 'verifying'], ['t-000002', 'verify_failed'], ['t-000003', 'awaiting_merge']] as const) {
      addLive(fixture.root, fixture.state, id, value);
    }
    writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
    const report = await dashboard(fixture.info);
    assert.equal(report.lanes.find((item) => item.lane === 'alpha')?.behind_trunk, true);
    assert.equal(report.lanes.find((item) => item.lane === 'alpha')?.changed_file_count, 1);
    for (const key of ['verifying', 'verify_failed', 'awaiting_merge']) assert.equal(report.tasks.counts[key], 1);
    const output = renderDashboard(report);
    for (const title of ['车道', '占位', '任务', '提示']) assert.match(output, new RegExp(`^${title}$`, 'm'));
    assert.match(output, /run_id=verify-t-000001/);
    assert.match(output, /t-000002 verify_failed/);
    assert.match(output, /t-000003 awaiting_merge/);
    assert.ok(output.split('\n').length <= 40);
    const json = cw(fixture.root, ['status', '--json']);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).tasks.items.length, 3);
  } finally { fixture.cleanup(); }
});

test('status hints count overdue reports, real spec drift, intent and artifacts without recovering any', async () => {
  const fixture = makeRepo();
  try {
    addLive(fixture.root, fixture.state, 't-000001', 'reported_done');
    addLive(fixture.root, fixture.state, 't-000002', 'claimed');
    const file = path.join(fixture.root, '.cowork', 'tasks', 't-000002.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('task t-000002', 'drifted title'));
    git(['add', file], fixture.root); git(['commit', '-qm', 'drift'], fixture.root);
    const intent = path.join(fixture.state, 'tasks', 'intents', 'op-leftover.json');
    mkdirSync(path.dirname(intent), { recursive: true }); writeFileSync(intent, '{"pending":true}');
    mkdirSync(path.join(fixture.state, 'lock.tmp-test'));
    mkdirSync(path.join(fixture.state, 'trash')); writeFileSync(path.join(fixture.state, 'trash', 'leftover'), 'trash');
    const before = readFileSync(path.join(fixture.state, 'tasks', 't-000002.json'), 'utf8');
    const report = await dashboard(fixture.info);
    assert.equal(report.hints.find((item) => item.kind === 'reported_done')?.count, 1);
    assert.equal(report.hints.find((item) => item.kind === 'spec_drift')?.count, 1, 'trunk 正常前进不算 spec 漂移');
    assert.equal(report.hints.find((item) => item.kind === 'intent')?.count, 1);
    assert.equal(report.hints.find((item) => item.kind === 'artifacts')?.count, 2);
    assert.equal(readFileSync(intent, 'utf8'), '{"pending":true}');
    assert.equal(readFileSync(path.join(fixture.state, 'tasks', 't-000002.json'), 'utf8'), before);
    assert.equal(existsSync(path.join(fixture.state, 'lock.tmp-test')), true);
  } finally { fixture.cleanup(); }
});

test('read-only status/snapshot/list/show ignore a held lock and never create or recover state', async () => {
  const fixture = makeRepo();
  try {
    await status(fixture.info); await snapshot(fixture.info); await dashboard(fixture.info);
    assert.equal(existsSync(fixture.state), false, '未初始化的 live 目录不应被只读创建');
    addLive(fixture.root, fixture.state, 't-000001', 'verifying');
    // 发布代表外部 writer 的合法 owner；测试自身不在 withLock 回调里运行任何命令。
    mkdirSync(path.join(fixture.state, 'lock'));
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: 'external-writer', acquiredAt: new Date().toISOString() });
    writeFileSync(path.join(fixture.state, 'lock', 'owner.json'), owner);
    for (const args of [['status'], ['snapshot', '--json'], ['task', 'ls', '--json'], ['task', 'show', 't-000001', '--json']]) {
      const start = performance.now();
      const result = cw(fixture.root, args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(performance.now() - start < 2000, `${args.join(' ')} 被写锁阻塞`);
      assert.equal(readFileSync(path.join(fixture.state, 'lock', 'owner.json'), 'utf8'), owner);
    }
  } finally { fixture.cleanup(); }
});

test('dashboard folds arbitrarily many lanes, claims and tasks into at most 40 physical lines', async () => {
  const fixture = makeRepo();
  try {
    const report = await dashboard(fixture.info);
    report.lanes = Array.from({ length: 50 }, (_, n) => ({ ...report.lanes[0]!, lane: `lane ${n}\nwrapped` }));
    report.claims = Array.from({ length: 50 }, (_, n) => ({
      path: `src/${n}.ts`, kind: 'file', lane: 'alpha', branch: 'dsh/alpha', agent: 'codex', pid: 1,
      host: 'HOST', note: null, createdAt: '', expiresAt: 'tomorrow', expired: false,
    }));
    report.tasks.items = Array.from({ length: 50 }, (_, n) => ({
      id: `t-${n}`, title: 'title\nline', status: 'verifying', touches: [], reads: [], depends_on: [], done_when: [],
      assigned_lane: null, agent: 'codex', spec_commit: null, updated_at: null, blocked_reason: null, verification: null,
    }));
    const text = renderDashboard(report);
    assert.ok(text.split('\n').length <= 40, `${text.split('\n').length} lines`);
    assert.match(text, /另 44 条/);
    assert.match(text, /另 42 条/);
    assert.equal(JSON.parse(JSON.stringify(report)).tasks.items.length, 50);
  } finally { fixture.cleanup(); }
});
