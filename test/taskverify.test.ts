import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, CoworkError } from '../src/errors.ts';
import { repoInfo } from '../src/git.ts';
import { stateRoot } from '../src/store.ts';
import { readTaskLive } from '../src/taskstore.ts';
import { confirmMerge, reportDone, readyTask, startTask } from '../src/taskops.ts';
import { next } from '../src/tasknext.ts';
import { taskDone } from '../src/taskverify.ts';
import { transitionTask } from '../src/taskstore.ts';
import { removeTree } from './helpers.ts';

const ID = 't-00a1b2';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(
  command: string[],
  timeout = 5000,
  envAllowlist = ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'COWORK_AGENT_ID'],
): { root: string; info: ReturnType<typeof repoInfo>; state: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cowork-verify-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'verify-test'], root);
  git(['config', 'user.email', 'verify@example.invalid'], root);
  mkdirSync(path.join(root, '.cowork', 'tasks'), { recursive: true });
  writeFileSync(path.join(root, '.cowork', 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    trunk: 'main',
    verification: {
      allow_disabled: false,
      commands: [{ name: 'probe', argv: command, timeout_ms: timeout, enabled: true }],
      env_allowlist: envAllowlist,
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(root, '.cowork', 'tasks', `${ID}.md`), `---\n${JSON.stringify({
    schemaVersion: 1, id: ID, title: 'verify', touches: ['src/**'], reads: [], depends_on: [],
    done_when: ['verify'], contracts: [], created_at: '2026-11-01T00:00:00.000Z',
  }, null, 2)}\n---\n\nTest task.\n`);
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);
  const info = repoInfo(root);
  const state = stateRoot(info);
  return { root, info, state, cleanup: () => removeTree(root) };
}

async function assigned(info: ReturnType<typeof repoInfo>): Promise<void> {
  await readyTask(info, ID);
  await next(info, { agent: 'alice', lane: null, lanePath: info.laneTop });
  await startTask(info, ID, 'alice');
  await reportDone(info, ID, 'alice');
}

test('task done 在锁外运行 trunk 配置并记录 config_commit', async () => {
  const fixture = makeRepo([process.execPath, '-e', 'process.stdout.write("passed")']);
  try {
    await assigned(fixture.info);
    const result = await taskDone(fixture.info, ID, 'alice');
    assert.equal(result.passed, true, result.message);
    assert.equal(result.live.status, 'awaiting_merge');
    assert.equal(result.live.verification?.status, 'passed');
    assert.equal(result.live.verification?.config_commit, git(['rev-parse', 'HEAD'], fixture.root));
    assert.equal(result.live.verification?.records[0]?.exit, 0);
    assert.match(result.live.verification?.records[0]?.summary ?? '', /passed/);
  } finally {
    fixture.cleanup();
  }
});

test('验证子进程始终收到当前任务的 COWORK_AGENT_ID', async () => {
  const fixture = makeRepo([process.execPath, '-e', 'process.stdout.write(process.env.COWORK_AGENT_ID ?? "missing")'], 5000, []);
  try {
    await assigned(fixture.info);
    const result = await taskDone(fixture.info, ID, 'alice');
    assert.equal(result.passed, true, result.message);
    assert.match(result.live.verification?.records[0]?.summary ?? '', /alice/);
  } finally {
    fixture.cleanup();
  }
});

test('task done 超时后 fail-closed 并保留 lease 状态', async () => {
  const fixture = makeRepo([process.execPath, '-e', 'setTimeout(() => {}, 2000)'], 100);
  try {
    await assigned(fixture.info);
    const result = await taskDone(fixture.info, ID, 'alice');
    assert.equal(result.passed, false);
    assert.equal(result.live.status, 'verify_failed');
    assert.equal(result.live.verification?.records[0]?.timed_out, true);
    assert.equal(result.live.lane, null);
    assert.equal(result.live.agent, 'alice');
  } finally {
    fixture.cleanup();
  }
});

test('验证 executable 无法启动时退回 reported_done 并记录 spawn', async () => {
  const fixture = makeRepo([path.join(os.tmpdir(), 'cowork-no-such-executable.exe')]);
  try {
    await assigned(fixture.info);
    const result = await taskDone(fixture.info, ID, 'alice');
    assert.equal(result.passed, false);
    assert.equal(result.live.status, 'reported_done');
    assert.equal(result.live.verification?.status, 'failed');
    assert.equal(result.live.verification?.records[0]?.exit, null);
    assert.equal(result.live.verification?.records[0]?.error, 'spawn');
    assert.doesNotMatch(result.live.status, /verifying/);
  } finally {
    fixture.cleanup();
  }
});

test('task done 初始 dirty 保持 reported_done；重复 verifying 返回 2', async () => {
  const fixture = makeRepo([process.execPath, '-e', 'setTimeout(() => {}, 500)']);
  try {
    await assigned(fixture.info);
    writeFileSync(path.join(fixture.root, 'untracked.tmp'), 'dirty');
    await assert.rejects(() => taskDone(fixture.info, ID, 'alice'), (err: unknown) =>
      err instanceof CoworkError && err.code === EXIT.GENERAL && /不干净/.test(err.message));
    assert.equal(readTaskLive(fixture.state, ID)?.status, 'reported_done');
    removeTree(path.join(fixture.root, 'untracked.tmp'));

    const pending = taskDone(fixture.info, ID, 'alice');
    const deadline = Date.now() + 3000;
    while (readTaskLive(fixture.state, ID)?.status !== 'verifying' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(() => taskDone(fixture.info, ID, 'alice'), (err: unknown) =>
      err instanceof CoworkError && err.code === EXIT.BUSY);
    const before = readTaskLive(fixture.state, ID)?.verification?.run_id;
    await pending;
    assert.ok(before);
  } finally {
    fixture.cleanup();
  }
});

test('task done 对 in_progress、merged、cancelled 返回 1 并说明当前状态', async () => {
  const inProgress = makeRepo([process.execPath, '-e', 'process.exit(0)']);
  const cancelled = makeRepo([process.execPath, '-e', 'process.exit(0)']);
  const merged = makeRepo([process.execPath, '-e', 'process.exit(0)']);
  try {
    await readyTask(inProgress.info, ID);
    await next(inProgress.info, { agent: 'alice', lane: null, lanePath: inProgress.info.laneTop });
    await startTask(inProgress.info, ID, 'alice');
    await assert.rejects(() => taskDone(inProgress.info, ID, 'alice'), (err: unknown) =>
      err instanceof CoworkError && err.code === EXIT.GENERAL && /in_progress/.test(err.message));

    transitionTask(stateRoot(cancelled.info), ID, 'cancelled');
    await assert.rejects(() => taskDone(cancelled.info, ID, 'alice'), (err: unknown) =>
      err instanceof CoworkError && err.code === EXIT.GENERAL && /cancelled/.test(err.message));

    await assigned(merged.info);
    const verification = await taskDone(merged.info, ID, 'alice');
    assert.equal(verification.live.status, 'awaiting_merge');
    await confirmMerge(merged.info, ID, {
      commit: git(['rev-parse', 'HEAD'], merged.root), manual: false, reason: null,
    });
    await assert.rejects(() => taskDone(merged.info, ID, 'alice'), (err: unknown) =>
      err instanceof CoworkError && err.code === EXIT.GENERAL && /merged/.test(err.message));
  } finally {
    inProgress.cleanup();
    cancelled.cleanup();
    merged.cleanup();
  }
});

test('running verification 即时记录当前命令与 PID', async () => {
  const fixture = makeRepo([process.execPath, '-e', 'setTimeout(() => process.stdout.write("done"), 1500)']);
  try {
    await assigned(fixture.info);
    const pending = taskDone(fixture.info, ID, 'alice');
    const deadline = Date.now() + 5000;
    let live = readTaskLive(fixture.state, ID);
    while (
      (live?.status !== 'verifying' || live.verification?.pid === null || live.verification?.records[0]?.exit !== null) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      live = readTaskLive(fixture.state, ID);
    }
    assert.equal(live?.status, 'verifying');
    assert.ok(live?.verification?.pid);
    assert.equal(live?.verification?.records[0]?.name, 'probe');
    assert.equal(live?.verification?.records[0]?.exit, null);
    assert.equal(live?.verification?.records[0]?.head, live?.verification?.head_before);
    assert.equal((await pending).live.status, 'awaiting_merge');
  } finally {
    fixture.cleanup();
  }
});

test('验证运行期间阻塞任务后记录结果并保持 blocked', async () => {
  const fixture = makeRepo([process.execPath, '-e', 'setTimeout(() => process.stdout.write("done"), 1200)']);
  try {
    await assigned(fixture.info);
    const pending = taskDone(fixture.info, ID, 'alice');
    const deadline = Date.now() + 5000;
    while (readTaskLive(fixture.state, ID)?.status !== 'verifying' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cli = path.resolve('src/cli.ts');
    const blocked = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--experimental-strip-types', cli, 'task', 'block', ID, '--reason', '等人工复核',
      ], {
        cwd: fixture.root,
        env: { ...process.env, COWORK_AGENT_ID: 'alice' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /blocked/);
    const result = await pending;
    assert.equal(result.live.status, 'blocked');
    assert.equal(result.live.verification?.status, 'passed');
    assert.equal(result.passed, false);
  } finally {
    fixture.cleanup();
  }
});

test('verification 摘要按 UTF-8 字节截断并保留尾部', async () => {
  const fixture = makeRepo([
    process.execPath, '-e', 'process.stdout.write("x".repeat(2047) + "🙂FAIL-TAIL")',
  ]);
  try {
    await assigned(fixture.info);
    const result = await taskDone(fixture.info, ID, 'alice');
    const summary = result.live.verification?.records[0]?.summary ?? '';
    assert.ok(Buffer.byteLength(summary, 'utf8') <= 2048);
    assert.ok(summary.endsWith('FAIL-TAIL'));
  } finally {
    fixture.cleanup();
  }
});
