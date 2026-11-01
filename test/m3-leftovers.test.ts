import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError } from '../src/errors.ts';
import { listClaims } from '../src/store.ts';
import { addTask, blockTask, cancelTask, readyTask, reportDone, startTask } from '../src/taskops.ts';
import { next } from '../src/tasknext.ts';
import { taskDone } from '../src/taskverify.ts';
import { doctorTasks } from '../src/taskdoctor.ts';
import { readTaskLive, transitionM2Task, writeTaskLive, type VerificationLive } from '../src/taskstore.ts';
import { cw, git, makeRepo } from './m3-helpers.ts';

async function fixtureFor(command = [process.execPath, '-e', 'process.stdout.write("ok")'], timeout = 5000) {
  const fixture = makeRepo();
  const config = {
    schemaVersion: 1, trunk: 'main', verification: {
      allow_disabled: false, commands: [{ name: 'probe', argv: command, timeout_ms: timeout, enabled: true }],
      env_allowlist: ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'COWORK_AGENT_ID'],
    },
  };
  writeFileSync(path.join(fixture.root, '.cowork', 'config.json'), JSON.stringify(config));
  const spec = await addTask(fixture.info, { title: 'M3 cleanup', touches: ['src/shared.ts'], reads: [], depends_on: [], done_when: [] });
  git(['add', '.'], fixture.root); git(['commit', '-qm', 'verification and spec'], fixture.root);
  await readyTask(fixture.info, spec.id);
  await next(fixture.info, { agent: 'owner', lane: null, lanePath: fixture.info.laneTop });
  await startTask(fixture.info, spec.id, 'owner');
  await reportDone(fixture.info, spec.id, 'owner');
  return { ...fixture, id: spec.id };
}

function verification(head: string, pid: number | null): VerificationLive {
  return {
    run_id: 'verify-m3-recovery', status: 'running', pid, host: hostname(), pid_started_at: null, pid_start_error: null,
    started_at: '2026-10-30T00:00:00.000Z', finished_at: null,
    head_before: head, head_after: null, config_commit: head, summary: '', records: [],
  };
}

test('task add prints one id, preserving the final ready-command line', () => {
  const fixture = makeRepo();
  try {
    const result = cw(fixture.root, ['task', 'add', '--title', 'single id', '--touches', 'src/one.ts']);
    assert.equal(result.status, 0, result.stderr);
    const ids = result.stdout.match(/t-[0-9a-f]{6}/g) ?? [];
    assert.equal(ids.length, 1, result.stdout);
    assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), `下一步: 把 spec 提交到 trunk 后运行 cowork task ready ${ids[0]}。`);
  } finally { fixture.cleanup(); }
});

test('awaiting_merge cancel enforces owner, releases lease/claims and allows the same path to be claimed again', async () => {
  const fixture = await fixtureFor();
  try {
    assert.equal((await taskDone(fixture.info, fixture.id, 'owner')).live.status, 'awaiting_merge');
    await assert.rejects(() => cancelTask(fixture.info, fixture.id, 'other', 'wrong owner'), (err) => err instanceof CoworkError && err.code === 2);
    assert.equal(listClaims(fixture.state).length, 1);
    const cancelled = await cancelTask(fixture.info, fixture.id, 'owner', 'not merging');
    assert.equal(cancelled.live.status, 'cancelled');
    assert.equal(cancelled.live.lane, null); assert.equal(cancelled.live.lanePath, null); assert.equal(cancelled.live.agent, null);
    assert.equal(cancelled.live.verification?.status, 'passed');
    assert.equal(cancelled.live.history.at(-1)?.from, 'awaiting_merge');
    assert.equal(cancelled.live.history.at(-1)?.agent, 'owner');
    assert.equal(listClaims(fixture.state).length, 0);
    const second = await addTask(fixture.info, { title: 'replacement', touches: ['src/shared.ts'], reads: [], depends_on: [], done_when: [] });
    git(['add', '.'], fixture.root); git(['commit', '-qm', 'replacement spec'], fixture.root);
    await readyTask(fixture.info, second.id);
    const picked = await next(fixture.info, { agent: 'other', lane: null, lanePath: fixture.info.laneTop });
    assert.equal(picked.task?.id, second.id);
  } finally { fixture.cleanup(); }
});

test('blocked stale verification recovery preserves task/claims and appends exactly one recovery history', async () => {
  const fixture = await fixtureFor();
  try {
    transitionM2Task(fixture.state, fixture.id, 'verifying', { verification: verification(git(['rev-parse', 'HEAD'], fixture.root), 2_000_000_000) });
    await blockTask(fixture.info, fixture.id, 'owner', 'waiting for judge');
    const before = readTaskLive(fixture.state, fixture.id)!;
    const claims = listClaims(fixture.state);
    await doctorTasks(fixture.info, false);
    assert.deepEqual(readTaskLive(fixture.state, fixture.id), before);
    await doctorTasks(fixture.info, true);
    const recovered = readTaskLive(fixture.state, fixture.id)!;
    assert.equal(recovered.status, 'blocked'); assert.equal(recovered.blocked_reason, 'waiting for judge');
    assert.equal(recovered.verification?.status, 'stale');
    assert.equal(recovered.history.length, before.history.length + 1);
    assert.equal(recovered.history.at(-1)?.from, 'blocked'); assert.equal(recovered.history.at(-1)?.to, 'blocked');
    assert.equal(recovered.history.at(-1)?.agent, 'doctor'); assert.match(recovered.history.at(-1)?.note ?? '', /recovery/);
    assert.deepEqual(listClaims(fixture.state), claims);
    await doctorTasks(fixture.info, true);
    assert.deepEqual(readTaskLive(fixture.state, fixture.id), recovered, '重跑 doctor 不重复追加历史');
  } finally { fixture.cleanup(); }
});

test('doctor leaves a blocked live verifier and a blocked completed verification untouched', async () => {
  const fixture = await fixtureFor();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    transitionM2Task(fixture.state, fixture.id, 'verifying', { verification: verification(git(['rev-parse', 'HEAD'], fixture.root), child.pid!) });
    await blockTask(fixture.info, fixture.id, 'owner', 'wait');
    const running = readTaskLive(fixture.state, fixture.id)!;
    await doctorTasks(fixture.info, true);
    assert.deepEqual(readTaskLive(fixture.state, fixture.id), running);
    writeTaskLive(fixture.state, { ...running, verification: { ...running.verification!, status: 'passed', pid: null } });
    const passed = readTaskLive(fixture.state, fixture.id);
    await doctorTasks(fixture.info, true);
    assert.deepEqual(readTaskLive(fixture.state, fixture.id), passed);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); });
    fixture.cleanup();
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return true;
  } catch { return false; }
}

test('verification timeout kills children and grandchildren, records timed_out and preserves claims', async () => {
  const deep = 'setInterval(() => {}, 1000)';
  const mid = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(deep)}], { stdio: 'inherit' }); console.log('descendant=' + child.pid); setInterval(() => {}, 1000);`;
  const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(mid)}], { stdio: 'inherit' }); console.log('descendant=' + child.pid); setInterval(() => {}, 1000);`;
  const fixture = await fixtureFor([process.execPath, '-e', parent], 1000);
  let descendants: number[] = [];
  try {
    const done = await taskDone(fixture.info, fixture.id, 'owner');
    assert.equal(done.passed, false); assert.equal(done.live.status, 'verify_failed');
    assert.equal(done.live.verification?.records[0]?.timed_out, true);
    descendants = [...done.output.matchAll(/descendant=(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(descendants.length, 2, done.output);
    const until = Date.now() + 3000;
    while (descendants.some(alive) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(descendants.every((pid) => !alive(pid)), `surviving descendants: ${descendants.filter(alive)}`);
    assert.equal(listClaims(fixture.state).length, 1);
  } finally {
    for (const pid of descendants.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    fixture.cleanup();
  }
});
