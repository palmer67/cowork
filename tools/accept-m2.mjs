#!/usr/bin/env node
/** M2 acceptance: executable coverage for docs/WORKORDER-M2.md items 1-20. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliPath = path.resolve(option('--cli', path.join(repoRoot, 'dist', 'cli.js')));
const liveRepos = [];
const activeChildren = new Set();
const activePids = new Set();

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const only = option('--only', '').split(',').filter(Boolean).map(Number).filter(Number.isFinite);
const keep = process.argv.includes('--keep');
if (!existsSync(cliPath)) {
  console.error(`找不到 CLI: ${cliPath}; 先运行 npm run build。`);
  process.exit(2);
}

const okCommand = {
  name: 'check',
  argv: [process.execPath, '-e', 'process.stdout.write("verified")'],
  timeout_ms: 15_000,
  enabled: true,
};
const defaultEnv = ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'CI', 'NODE_ENV', 'COWORK_AGENT_ID'];

function run(command, args, cwd, env = {}, timeout = 120_000) {
  const childEnv = { ...process.env, ...env };
  if (process.platform === 'win32') {
    const index = Number(childEnv.GIT_CONFIG_COUNT ?? '0');
    childEnv[`GIT_CONFIG_KEY_${index}`] = 'core.symlinks';
    childEnv[`GIT_CONFIG_VALUE_${index}`] = 'false';
    childEnv.GIT_CONFIG_COUNT = String(index + 1);
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: childEnv,
    windowsHide: true,
    shell: false,
    timeout,
  });
  return {
    code: result.status ?? (result.error === undefined ? 1 : -1),
    out: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error === undefined ? '' : `\n${result.error.message}`}`,
  };
}

function git(cwd, args, timeout = 120_000) {
  const result = run('git', args, cwd, {}, timeout);
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.out.trim().slice(0, 500)}`);
  return result.out.trim();
}

function cw(cwd, args, agent = 'dsh', extraEnv = {}, timeout = 120_000) {
  return run(process.execPath, [cliPath, ...args], cwd, { ...extraEnv, COWORK_AGENT_ID: agent }, timeout);
}

function spawnCw(cwd, args, agent = 'dsh', extraEnv = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv, COWORK_AGENT_ID: agent },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { out += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { out += part; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      activeChildren.delete(child);
      resolve({ code: code ?? -1, signal, out });
    });
  });
  return { child, done };
}

function newRepo(commands = [okCommand]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cowork-m2-accept-'));
  liveRepos.push(root);
  const result = run('git', ['init', '-q', '-b', 'main'], root);
  assert.equal(result.code, 0, `git init failed: ${result.out}`);
  git(root, ['config', 'user.email', 'accept@example.com']);
  git(root, ['config', 'user.name', 'accept']);
  writeFileSync(path.join(root, 'README.md'), '# M2 acceptance\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial commit']);
  const init = cw(root, ['init']);
  assert.equal(init.code, 0, `cowork init failed: ${init.out}`);
  setConfig(root, commands);
  git(root, ['add', '.cowork/config.json']);
  git(root, ['commit', '-qm', 'configure M2 verification']);
  return root;
}

function setConfig(root, commands, allowDisabled = false) {
  const config = {
    schemaVersion: 1,
    trunk: 'main',
    verification: { allow_disabled: allowDisabled, commands, env_allowlist: defaultEnv },
  };
  writeFileSync(path.join(root, '.cowork', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function addReadyTasks(root, definitions) {
  const ids = [];
  for (const definition of definitions) {
    const args = ['task', 'add', '--title', definition.title];
    for (const touch of definition.touches) args.push('--touches', touch);
    for (const read of definition.reads ?? []) args.push('--reads', read);
    for (const dep of definition.depends ?? []) args.push('--depends', dep);
    for (const doneWhen of definition.doneWhen ?? []) args.push('--done-when', doneWhen);
    const result = cw(root, args);
    assert.equal(result.code, 0, `task add failed: ${result.out}`);
    const id = result.out.match(/t-[0-9a-f]{6}/)?.[0];
    assert.ok(id, `task add did not return an id: ${result.out}`);
    ids.push(id);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'add M2 acceptance task specs']);
  for (const id of ids) {
    const ready = cw(root, ['task', 'ready', id]);
    assert.equal(ready.code, 0, `task ready failed for ${id}: ${ready.out}`);
  }
  return ids;
}

function createLane(root, name) {
  const laneDir = path.join(root, '.cowork', 'lanes', name);
  git(root, ['worktree', 'add', '--quiet', laneDir, '-b', `accept/${name}`, 'main']);
  return laneDir;
}

function takeTask(laneDir, id, agent = path.basename(laneDir)) {
  const result = cw(laneDir, ['next'], agent);
  assert.equal(result.code, 0, `next failed in ${agent}: ${result.out}`);
  assert.ok(result.out.includes(id), `expected ${agent} to take ${id}: ${result.out}`);
  return result;
}

function startTask(laneDir, id, agent = path.basename(laneDir)) {
  const result = cw(laneDir, ['task', 'start', id], agent);
  assert.equal(result.code, 0, `task start failed: ${result.out}`);
  return result;
}

function reportDone(laneDir, id, agent = path.basename(laneDir)) {
  const result = cw(laneDir, ['task', 'report-done', id], agent);
  assert.equal(result.code, 0, `report-done failed: ${result.out}`);
  return result;
}

function setupTask(root, definition, laneName) {
  const [id] = addReadyTasks(root, [definition]);
  const laneDir = createLane(root, laneName);
  takeTask(laneDir, id);
  startTask(laneDir, id);
  reportDone(laneDir, id);
  return { id, laneDir };
}

function setupInProgress(root, definition, laneName) {
  const [id] = addReadyTasks(root, [definition]);
  const laneDir = createLane(root, laneName);
  takeTask(laneDir, id);
  startTask(laneDir, id);
  return { id, laneDir };
}

function commonDir(root) {
  return git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

function liveFile(root, id) {
  return path.join(commonDir(root), 'cowork', 'tasks', `${id}.json`);
}

function readLive(root, id) {
  return JSON.parse(readFileSync(liveFile(root, id), 'utf8'));
}

function readSnapshot(root) {
  const result = cw(root, ['snapshot', '--json']);
  assert.equal(result.code, 0, `snapshot failed: ${result.out}`);
  return JSON.parse(result.out);
}

async function waitForLive(root, id, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(liveFile(root, id))) {
      const live = readLive(root, id);
      if (predicate(live)) return live;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for task ${id} live condition`);
}

function writeHandoff(laneDir, name, metadata) {
  const notes = path.join(laneDir, '.cowork', 'notes');
  mkdirSync(notes, { recursive: true });
  const file = path.join(notes, name);
  writeFileSync(file, `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n# acceptance handoff\n`, 'utf8');
  return file;
}

function ensureExit(result, code, context) {
  assert.equal(result.code, code, `${context}: expected exit ${code}, got ${result.code}\n${result.out}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitForPidGone(pid, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && pidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 30));
  return !pidAlive(pid);
}

function terminatePid(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  activePids.delete(pid);
}

function renderBoard(snapshot) {
  return import(pathToFileURL(path.join(path.dirname(cliPath), 'ui.js')).href).then(({ renderBoard: render }) => render(snapshot));
}

const checks = [];
const define = (id, title, fn) => checks.push({ id, title, fn });

define(1, 'verifying keeps overlapping touches held from another lane', async () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("done"),3000)'] }]);
  const [first, second] = addReadyTasks(root, [
    { title: 'verify shared owner', touches: ['src/shared/**'] },
    { title: 'overlapping waiter', touches: ['src/shared/file.ts'] },
  ]);
  const owner = createLane(root, 'owner');
  const other = createLane(root, 'other');
  takeTask(owner, first, 'owner');
  startTask(owner, first, 'owner');
  reportDone(owner, first, 'owner');
  const worker = spawnCw(owner, ['task', 'done', first], 'owner');
  await waitForLive(root, first, (live) => live.status === 'verifying' && live.verification?.pid !== null);
  const started = performance.now();
  const next = cw(other, ['next'], 'other');
  assert.notEqual(next.code, 0, `overlapping next unexpectedly succeeded: ${next.out}`);
  assert.ok(performance.now() - started < 2_000, 'next waited for the full verification');
  assert.equal(readLive(root, second).status, 'ready');
  const done = await worker.done;
  assert.equal(done.code, 0, done.out);
});

define(2, 'nonzero verification fails and keeps claims', () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'process.stdout.write("bad");process.exit(7)'] }]);
  const { id, laneDir } = setupTask(root, { title: 'failing check', touches: ['src/fail.ts'] }, 'fail');
  const result = cw(laneDir, ['task', 'done', id], 'fail');
  ensureExit(result, 1, 'nonzero verification');
  assert.match(result.out, /bad/);
  assert.equal(readLive(root, id).status, 'verify_failed');
  assert.ok(readSnapshot(root).claims.some((claim) => claim.path === 'src/fail.ts'));
});

define(3, 'HEAD movement during verification fails closed', async () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("done"),2500)'] }]);
  const { id, laneDir } = setupTask(root, { title: 'head drift', touches: ['src/head.ts'] }, 'head');
  const worker = spawnCw(laneDir, ['task', 'done', id], 'head');
  await waitForLive(root, id, (live) => live.status === 'verifying' && live.verification?.pid !== null);
  git(laneDir, ['commit', '--allow-empty', '-qm', 'move HEAD during verification']);
  const done = await worker.done;
  ensureExit(done, 1, 'HEAD drift');
  assert.equal(readLive(root, id).status, 'verify_failed');
});

define(4, 'initial tracked or untracked dirty state preserves reported_done', () => {
  const root = newRepo();
  const { id, laneDir } = setupTask(root, { title: 'dirty check', touches: ['src/dirty.ts'] }, 'dirty');
  writeFileSync(path.join(laneDir, 'README.md'), '# dirty\n', 'utf8');
  const result = cw(laneDir, ['task', 'done', id], 'dirty');
  ensureExit(result, 1, 'initial dirty');
  assert.equal(readLive(root, id).status, 'reported_done');
});

define(5, 'squash target requires manual confirmation and a reason', () => {
  const root = newRepo();
  const { id, laneDir } = setupInProgress(root, { title: 'squash target', touches: ['src/squash.ts'] }, 'squash');
  writeFileSync(path.join(laneDir, 'src-squash.txt'), 'change\n', 'utf8');
  git(laneDir, ['add', 'src-squash.txt']);
  git(laneDir, ['commit', '-qm', 'lane change']);
  reportDone(laneDir, id, 'squash');
  const result = cw(laneDir, ['task', 'done', id], 'squash');
  ensureExit(result, 0, 'verification before squash confirmation');
  const target = git(root, ['rev-parse', 'main']);
  const withoutManual = cw(root, ['task', 'confirm-merge', id, '--commit', target]);
  ensureExit(withoutManual, 1, 'squash without --manual');
  const withoutReason = cw(root, ['task', 'confirm-merge', id, '--commit', target, '--manual']);
  ensureExit(withoutReason, 1, 'squash without --reason');
  assert.equal(readLive(root, id).status, 'awaiting_merge');
});

define(6, 'reads and touches alerts appear in next, brief, and snapshot', () => {
  const root = newRepo();
  const [reader, writer] = addReadyTasks(root, [
    { title: 'reads shared API', touches: ['src/reader.ts'], reads: ['src/shared/api.ts'] },
    { title: 'writes shared API', touches: ['src/shared/api.ts'] },
  ]);
  const lane = createLane(root, 'reader');
  const next = cw(lane, ['next', '--json'], 'reader');
  ensureExit(next, 0, 'next with contract alert');
  const result = JSON.parse(next.out);
  assert.equal(result.task.id, reader);
  assert.ok(result.contract_alerts.some((alert) => alert.kind === 'reads_touches' && alert.task === reader && alert.peer_task === writer));
  const brief = cw(lane, ['brief'], 'reader');
  ensureExit(brief, 0, 'brief with contract alert');
  assert.match(brief.out, /reads_touches/);
  const snapshot = readSnapshot(root);
  assert.ok(snapshot.contract_alerts.some((alert) => alert.kind === 'reads_touches' && alert.task === reader && alert.peer_task === writer));
});

define(7, 'handoff alerts disappear when removed and malformed metadata is diagnosed', () => {
  const root = newRepo();
  const [reader] = addReadyTasks(root, [{ title: 'read contract', touches: ['src/reader.ts'], reads: ['src/api.ts'] }]);
  const source = createLane(root, 'source');
  const handoff = writeHandoff(source, 'contract.md', { lane: 'source', task_id: 't-source1', contracts_changed: [{ paths: ['src/api.ts'], old: 'A', new: 'B' }] });
  let snapshot = readSnapshot(root);
  assert.ok(snapshot.contract_alerts.some((alert) => alert.kind === 'reads_contract' && alert.task === reader));
  rmSync(handoff);
  snapshot = readSnapshot(root);
  assert.ok(!snapshot.contract_alerts.some((alert) => alert.kind === 'reads_contract' && alert.task === reader));
  const broken = path.join(path.dirname(handoff), 'broken.md');
  writeFileSync(broken, '---\n{ broken JSON\n---\n', 'utf8');
  snapshot = readSnapshot(root);
  const lane = snapshot.lanes.find((item) => item.lane === 'source');
  assert.ok(lane?.handoff_diagnostics?.some((line) => line.includes('broken.md')));
});

define(8, 'doctor --fix recovers an exited verifier and records recovery', async () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeout_ms: 60_000 }]);
  const { id, laneDir } = setupTask(root, { title: 'recover killed verifier', touches: ['src/recovery.ts'] }, 'recovery');
  const worker = spawnCw(laneDir, ['task', 'done', id], 'recovery');
  const live = await waitForLive(root, id, (item) => item.status === 'verifying' && item.verification?.pid !== null && (item.verification?.pid_started_at !== null || item.verification?.pid_start_error !== null));
  const pid = live.verification.pid;
  assert.ok(pid);
  activePids.add(pid);
  worker.child.kill('SIGKILL');
  terminatePid(pid);
  await worker.done;
  assert.ok(await waitForPidGone(pid), `verification pid ${pid} is still alive`);
  const doctor = cw(root, ['doctor', '--fix']);
  ensureExit(doctor, 0, 'doctor --fix recovery');
  const recovered = readLive(root, id);
  assert.equal(recovered.status, 'reported_done');
  assert.equal(recovered.verification.status, 'stale');
  assert.equal(recovered.recovery.run_id, live.verification.run_id);
  assert.match(recovered.recovery.reason, /已不存在/);
  assert.ok(readSnapshot(root).claims.some((claim) => claim.path === 'src/recovery.ts'));
});

define(9, 'unknown PID start time prompts without recovery and does not fail task done', async () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("done"),3500)'] }]);
  const { id, laneDir } = setupTask(root, { title: 'unknown verifier start', touches: ['src/pid.ts'] }, 'pid');
  const gitDir = (process.env.PATH ?? '').split(path.delimiter).find((entry) => existsSync(path.join(entry, process.platform === 'win32' ? 'git.exe' : 'git')));
  assert.ok(gitDir, 'could not find git executable directory for restricted PATH test');
  const worker = spawnCw(laneDir, ['task', 'done', id], 'pid', { PATH: gitDir });
  const running = await waitForLive(root, id, (live) => live.status === 'verifying' && live.verification?.pid !== null && live.verification?.pid_start_error !== null);
  assert.equal(running.verification.pid_started_at, null);
  const doctor = cw(root, ['doctor', '--fix']);
  ensureExit(doctor, 0, 'doctor with unknown PID start time');
  assert.match(doctor.out, /拒绝恢复/);
  assert.equal(readLive(root, id).status, 'verifying');
  const done = await worker.done;
  ensureExit(done, 0, 'verification despite PID start-time lookup failure');
  assert.equal(readLive(root, id).status, 'awaiting_merge');
});

define(10, 'snapshot exposes running, failed, and passed verification details', async () => {
  const script = 'const p=require("path").basename(process.cwd());if(p==="running")setTimeout(()=>process.stdout.write("run summary"),8000);else if(p==="failed"){process.stdout.write("failure summary");process.exit(6)}else process.stdout.write("pass summary")';
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', script], timeout_ms: 20_000 }]);
  const [runningId, failedId, passedId] = addReadyTasks(root, [
    { title: 'running task', touches: ['src/running.ts'] },
    { title: 'failed task', touches: ['src/failed.ts'] },
    { title: 'passed task', touches: ['src/passed.ts'] },
  ]);
  const runningLane = createLane(root, 'running');
  const failedLane = createLane(root, 'failed');
  const passedLane = createLane(root, 'passed');
  takeTask(runningLane, runningId, 'running');
  startTask(runningLane, runningId, 'running');
  reportDone(runningLane, runningId, 'running');
  const worker = spawnCw(runningLane, ['task', 'done', runningId], 'running');
  await waitForLive(root, runningId, (live) => live.status === 'verifying' && live.verification?.pid !== null);
  takeTask(failedLane, failedId, 'failed');
  startTask(failedLane, failedId, 'failed');
  reportDone(failedLane, failedId, 'failed');
  ensureExit(cw(failedLane, ['task', 'done', failedId], 'failed'), 1, 'failed snapshot sample');
  takeTask(passedLane, passedId, 'passed');
  startTask(passedLane, passedId, 'passed');
  reportDone(passedLane, passedId, 'passed');
  ensureExit(cw(passedLane, ['task', 'done', passedId], 'passed'), 0, 'passed snapshot sample');
  const snapshot = readSnapshot(root);
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const [id, status] of [[runningId, 'verifying'], [failedId, 'verify_failed'], [passedId, 'awaiting_merge']]) {
    const task = byId.get(id);
    assert.equal(task?.status, status);
    assert.ok(task?.verification?.records.length);
    assert.ok(task.verification.records[0].head);
    assert.equal(typeof task.verification.records[0].duration_ms, 'number');
    assert.equal(typeof task.verification.records[0].summary, 'string');
  }
  assert.equal(byId.get(runningId).verification.records[0].exit, null);
  assert.equal(byId.get(failedId).verification.records[0].exit, 6);
  assert.equal(byId.get(passedId).verification.records[0].exit, 0);
  assert.match(byId.get(failedId).verification.summary, /failure summary/);
  assert.match(byId.get(passedId).verification.summary, /pass summary/);
  assert.equal((await worker.done).code, 0);
});

define(11, 'confirm-merge validates target ancestry and releases claims on success', () => {
  const root = newRepo();
  const { id, laneDir } = setupInProgress(root, { title: 'merge verification', touches: ['src/merge.ts'] }, 'merge');
  writeFileSync(path.join(laneDir, 'merge.txt'), 'merge\n', 'utf8');
  git(laneDir, ['add', 'merge.txt']);
  git(laneDir, ['commit', '-qm', 'merge candidate']);
  reportDone(laneDir, id, 'merge');
  ensureExit(cw(laneDir, ['task', 'done', id], 'merge'), 0, 'merge verification');
  const missing = cw(root, ['task', 'confirm-merge', id, '--commit', 'deadbeef']);
  ensureExit(missing, 1, 'missing target commit');
  const parent = git(root, ['rev-parse', 'main']);
  const notAncestor = cw(root, ['task', 'confirm-merge', id, '--commit', parent]);
  ensureExit(notAncestor, 1, 'target without verified HEAD ancestry');
  assert.equal(readLive(root, id).status, 'awaiting_merge');
  assert.ok(readSnapshot(root).claims.some((claim) => claim.path === 'src/merge.ts'));
  git(root, ['merge', '--ff-only', 'accept/merge']);
  const target = git(root, ['rev-parse', 'HEAD']);
  ensureExit(cw(root, ['task', 'confirm-merge', id, '--commit', target]), 0, 'confirmed merge');
  assert.equal(readLive(root, id).status, 'merged');
  assert.ok(!readSnapshot(root).claims.some((claim) => claim.path === 'src/merge.ts'));
});

define(12, 'rename, delete, recursive paths, and segment boundaries use the same matcher', () => {
  const root = newRepo();
  mkdirSync(path.join(root, 'src', 'foo'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'foobar'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'foo', 'old.ts'), 'old\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'foo', 'deleted.ts'), 'gone\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'foobar', 'near.ts'), 'near\n', 'utf8');
  git(root, ['add', 'src']);
  git(root, ['commit', '-qm', 'add matcher fixtures']);
  const [reader] = addReadyTasks(root, [{ title: 'recursive reader', touches: ['src/reader.ts'], reads: ['src/foo/**'] }]);
  const source = createLane(root, 'source');
  git(source, ['mv', 'src/foo/old.ts', 'src/foo/new.ts']);
  git(source, ['rm', 'src/foo/deleted.ts']);
  git(source, ['commit', '-qm', 'rename and delete paths']);
  writeHandoff(source, 'contract.md', {
    lane: 'source',
    task_id: 't-source1',
    contracts_changed: [{ paths: ['src/foo/old.ts', 'src/foo/new.ts', 'src/foo/deleted.ts', 'src/foobar/near.ts'] }],
  });
  const alerts = readSnapshot(root).contract_alerts.filter((item) => item.kind === 'reads_contract' && item.task === reader);
  assert.deepEqual(new Set(alerts.map((item) => item.path)), new Set(['src/foo/old.ts', 'src/foo/new.ts', 'src/foo/deleted.ts']));
});

define(13, 'dirty verification side effects fail while external temp output passes', () => {
  const tempOutput = path.join(os.tmpdir(), `cowork-m2-${process.pid}-${Date.now()}.tmp`);
  const script = `const fs=require("fs"),path=require("path");if(path.basename(process.cwd())==="dirty")fs.writeFileSync("generated.txt","x");else fs.writeFileSync(${JSON.stringify(tempOutput)},"x")`;
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', script] }]);
  const [dirtyId, cleanId] = addReadyTasks(root, [
    { title: 'dirty output', touches: ['src/dirty.ts'] },
    { title: 'external output', touches: ['src/clean.ts'] },
  ]);
  const dirtyLane = createLane(root, 'dirty');
  const cleanLane = createLane(root, 'clean');
  takeTask(dirtyLane, dirtyId, 'dirty');
  startTask(dirtyLane, dirtyId, 'dirty');
  reportDone(dirtyLane, dirtyId, 'dirty');
  ensureExit(cw(dirtyLane, ['task', 'done', dirtyId], 'dirty'), 1, 'dirty verifier output');
  assert.equal(readLive(root, dirtyId).status, 'verify_failed');
  assert.equal(readFileSync(path.join(dirtyLane, 'generated.txt'), 'utf8'), 'x');
  takeTask(cleanLane, cleanId, 'clean');
  startTask(cleanLane, cleanId, 'clean');
  reportDone(cleanLane, cleanId, 'clean');
  ensureExit(cw(cleanLane, ['task', 'done', cleanId], 'clean'), 0, 'external verifier output');
  assert.equal(readLive(root, cleanId).status, 'awaiting_merge');
  rmSync(tempOutput, { force: true });
});

define(14, 'timeout records timed_out and preserves verification claims', () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("late"),3000)'], timeout_ms: 1000 }]);
  const { id, laneDir } = setupTask(root, { title: 'timeout check', touches: ['src/timeout.ts'] }, 'timeout');
  const result = cw(laneDir, ['task', 'done', id], 'timeout', {}, 15_000);
  ensureExit(result, 1, 'verification timeout');
  const live = readLive(root, id);
  assert.equal(live.status, 'verify_failed');
  assert.equal(live.verification.records[0].timed_out, true);
  assert.ok(readSnapshot(root).claims.some((claim) => claim.path === 'src/timeout.ts'));
});

define(15, 'next and lane new return within two seconds during a five-second verification', async () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("done"),5000)'], timeout_ms: 15_000 }]);
  const [slowId, nextId] = addReadyTasks(root, [
    { title: 'five second verification', touches: ['src/slow.ts'] },
    { title: 'parallel lane task', touches: ['src/parallel.ts'] },
  ]);
  const slowLane = createLane(root, 'slow');
  const nextLane = createLane(root, 'parallel');
  takeTask(slowLane, slowId, 'slow');
  startTask(slowLane, slowId, 'slow');
  reportDone(slowLane, slowId, 'slow');
  const worker = spawnCw(slowLane, ['task', 'done', slowId], 'slow');
  await waitForLive(root, slowId, (live) => live.status === 'verifying' && live.verification?.pid !== null);
  let started = performance.now();
  const next = cw(nextLane, ['next'], 'parallel');
  const nextMs = performance.now() - started;
  ensureExit(next, 0, 'parallel next');
  assert.ok(next.out.includes(nextId));
  assert.ok(nextMs < 2_000, `parallel next took ${nextMs.toFixed(0)}ms`);
  started = performance.now();
  const lane = cw(root, ['lane', 'new', 'fresh']);
  const laneMs = performance.now() - started;
  ensureExit(lane, 0, 'parallel lane new');
  assert.ok(laneMs < 2_000, `lane new took ${laneMs.toFixed(0)}ms`);
  assert.equal((await worker.done).code, 0);
});

define(16, 'duplicate task done while verifying exits 2 without adding a record', async () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("done"),2500)'] }]);
  const { id, laneDir } = setupTask(root, { title: 'duplicate done', touches: ['src/duplicate.ts'] }, 'duplicate');
  const worker = spawnCw(laneDir, ['task', 'done', id], 'duplicate');
  await waitForLive(root, id, (live) => live.status === 'verifying' && live.verification?.records.length === 1);
  const repeat = cw(laneDir, ['task', 'done', id], 'duplicate');
  ensureExit(repeat, 2, 'duplicate task done');
  assert.match(repeat.out, /正在验证中/);
  assert.equal(readLive(root, id).verification.records.length, 1);
  assert.equal((await worker.done).code, 0);
  assert.equal(readLive(root, id).verification.records.length, 1);
});

define(17, 'panel shows three verification states and a retry copy command', async () => {
  const verification = (status, exit, summary) => ({
    run_id: `verify-${status}`, status, pid: null, host: 'HOST', pid_started_at: null,
    pid_start_error: null, started_at: new Date().toISOString(), finished_at: null,
    head_before: 'a'.repeat(40), head_after: null, config_commit: 'b'.repeat(40), summary,
    records: [{ name: 'check', argv: ['node', 'test'], exit, timed_out: false, duration_ms: 12, head: 'a'.repeat(40), summary, at: new Date().toISOString() }],
  });
  const task = (id, status, verify) => ({
    id, title: id, status, touches: [], reads: [], depends_on: [], done_when: [],
    assigned_lane: 'lane', agent: 'lane', spec_commit: 'c'.repeat(40), updated_at: new Date().toISOString(),
    blocked_reason: null, verification: verify,
  });
  const html = await renderBoard({
    schemaVersion: 1, generatedAt: new Date().toISOString(), repo: { root: 'test', head: 'abc', trunk: 'main' },
    tasks: [task('t-run001', 'verifying', verification('running', null, 'running')), task('t-pass01', 'awaiting_merge', verification('passed', 0, 'passed')), task('t-fail01', 'verify_failed', verification('failed', 1, 'failed'))],
    task_diagnostics: [], claims: [], contract_alerts: [], lanes: [],
  });
  for (const status of ['verifying', 'awaiting_merge', 'verify_failed']) assert.ok(html.includes(status));
  assert.ok(html.includes('data-copy="cowork task done t-fail01"'));
  assert.ok(html.includes('重跑验证'));
});

define(18, 'lane config edits cannot replace trunk verification config', () => {
  const root = newRepo([{ ...okCommand, argv: [process.execPath, '-e', 'process.exit(9)'] }]);
  const { id, laneDir } = setupInProgress(root, { title: 'trunk config source', touches: ['src/config.ts'] }, 'config');
  const trunkSha = git(root, ['rev-parse', 'main']);
  const laneConfigPath = path.join(laneDir, '.cowork', 'config.json');
  const laneConfig = JSON.parse(readFileSync(laneConfigPath, 'utf8'));
  laneConfig.verification.commands[0].argv = [process.execPath, '-e', 'process.stdout.write("lane-pass")'];
  writeFileSync(laneConfigPath, `${JSON.stringify(laneConfig, null, 2)}\n`, 'utf8');
  git(laneDir, ['add', '.cowork/config.json']);
  git(laneDir, ['commit', '-qm', 'weaken lane verification config']);
  reportDone(laneDir, id, 'config');
  const result = cw(laneDir, ['task', 'done', id], 'config');
  ensureExit(result, 1, 'trunk verification config');
  const live = readLive(root, id);
  assert.equal(live.status, 'verify_failed');
  assert.equal(live.verification.config_commit, trunkSha);
  assert.equal(live.verification.records[0].exit, 9);
});

define(19, 'reported_done cannot merge and remains visibly unverified after 24 hours', () => {
  const root = newRepo();
  const { id, laneDir } = setupTask(root, { title: 'unverified report', touches: ['src/unverified.ts'] }, 'unverified');
  const target = git(root, ['rev-parse', 'main']);
  const merge = cw(root, ['task', 'confirm-merge', id, '--commit', target]);
  ensureExit(merge, 1, 'merge reported_done');
  assert.match(merge.out, /尚未验证，请先.*task done/);
  assert.equal(readLive(root, id).status, 'reported_done');
  const brief = cw(laneDir, ['brief'], 'unverified');
  ensureExit(brief, 0, 'reported_done brief');
  assert.match(brief.out, /reported_done \/ 未验证/);
  const htmlFile = path.join(os.tmpdir(), `cowork-m2-panel-${process.pid}-${Date.now()}.html`);
  const panel = cw(root, ['ui', '--out', htmlFile]);
  ensureExit(panel, 0, 'reported_done panel');
  assert.match(readFileSync(htmlFile, 'utf8'), /未验证/);
  rmSync(htmlFile, { force: true });
  const livePath = liveFile(root, id);
  const live = readLive(root, id);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  live.updated_at = old;
  for (const entry of live.history) if (entry.to === 'reported_done') entry.at = old;
  writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  const doctor = cw(root, ['doctor']);
  ensureExit(doctor, 0, 'unverified doctor notice');
  assert.match(doctor.out, /reported_done 超过 24 小时，尚未验证/);
  assert.equal(readLive(root, id).status, 'reported_done');
});

define(20, 'spawn failure restores reported_done without a verifying residue', () => {
  const root = newRepo([{ ...okCommand, argv: [path.join(rootTempPath(), 'missing-verifier.exe')] }]);
  const { id, laneDir } = setupTask(root, { title: 'missing executable', touches: ['src/spawn.ts'] }, 'spawn');
  const result = cw(laneDir, ['task', 'done', id], 'spawn');
  ensureExit(result, 1, 'missing verifier executable');
  const live = readLive(root, id);
  assert.equal(live.status, 'reported_done');
  assert.equal(live.verification.status, 'failed');
  assert.match(live.verification.summary, /启动失败/);
  assert.equal(live.verification.records[0].exit, null);
  assert.equal(live.verification.records[0].error, 'spawn');
  assert.ok(!readSnapshot(root).tasks.some((task) => task.id === id && task.status === 'verifying'));
});

function rootTempPath() {
  return path.join(os.tmpdir(), `cowork-m2-missing-${process.pid}-${Date.now()}`);
}

process.on('exit', () => {
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
  for (const pid of activePids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  if (!keep) {
    for (const root of liveRepos) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* report checks, not cleanup, */ }
    }
  }
});

let passed = 0;
let failed = 0;
for (const check of checks) {
  if (only.length > 0 && !only.includes(check.id)) continue;
  try {
    await check.fn();
    passed += 1;
    console.log(`PASS ${check.id}. ${check.title}`);
  } catch (err) {
    failed += 1;
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`FAIL ${check.id}. ${check.title}\n${message}`);
  }
}
console.log(`${passed} PASS / ${failed} FAIL`);
if (failed !== 0) process.exitCode = 1;
