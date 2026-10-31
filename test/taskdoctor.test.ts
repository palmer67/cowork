import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claimTtlMs } from '../src/claims.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { parseClaim } from '../src/paths.ts';
import { claimId, ensureState, stateRoot, writeClaim } from '../src/store.ts';
import { readTaskLive, transitionTask } from '../src/taskstore.ts';
import { doctorTasks } from '../src/taskdoctor.ts';
import { writeIntent, type NextIntent } from '../src/tasknext.ts';
import { removeTree } from './helpers.ts';

interface Fixture {
  root: string;
  info: RepoInfo;
  state: string;
  cleanup: () => void;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function specText(meta: Record<string, unknown>): string {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n## 背景\n\n测试任务。\n`;
}

function makeRepo(specs: Record<string, unknown>[], names?: Record<string, string>): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-doctor-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'test'], root);
  writeFileSync(path.join(root, 'README.md'), '# test\n', 'utf8');
  mkdirSync(path.join(root, '.cowork', 'tasks'), { recursive: true });
  writeFileSync(
    path.join(root, '.cowork', 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, trunk: 'main' }, null, 2)}\n`,
    'utf8',
  );
  for (const meta of specs) {
    const id = String(meta['id']);
    const name = names?.[id] ?? `${id}.md`;
    writeFileSync(path.join(root, '.cowork', 'tasks', name), specText(meta), 'utf8');
  }
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);
  const info = repoInfo(root);
  return { root, info, state: stateRoot(info), cleanup: () => removeTree(root) };
}

function meta(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    title: `task ${id}`,
    touches: [`src/${id}.ts`],
    reads: [],
    depends_on: [],
    done_when: [],
    contracts: [],
    created_at: '2026-10-30T09:00:00.000Z',
    ...overrides,
  };
}

test('干净的仓库 doctor 不报任务问题', async () => {
  const fixture = makeRepo([meta('t-00a1b2')]);
  try {
    const report = await doctorTasks(fixture.info, false);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.fixed, []);
  } finally {
    fixture.cleanup();
  }
});

test('doctor 提示并清理过期锁临时目录与 trash 条目，但普通检查不报红', async () => {
  const fixture = makeRepo([meta('t-00a1b2')]);
  try {
    ensureState(fixture.state);
    const oldLock = new Date(Date.now() - 61_000);
    const oldTrash = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const lockTmp = path.join(fixture.state, 'lock.tmp-test');
    mkdirSync(lockTmp);
    utimesSync(lockTmp, oldLock, oldLock);
    const trashEntry = path.join(fixture.state, 'trash', 'old-lock');
    mkdirSync(trashEntry);
    utimesSync(trashEntry, oldTrash, oldTrash);

    const before = await doctorTasks(fixture.info, false);
    assert.deepEqual(before.problems, []);
    assert.equal(before.notices.length, 2);
    assert.ok(before.notices.some((line) => line.includes('lock.tmp-test') && line.includes('60 秒')));
    assert.ok(before.notices.some((line) => line.includes('old-lock') && line.includes('24 小时')));

    const cli = path.resolve('src/cli.ts');
    const doctor = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'doctor'], {
      cwd: fixture.root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /提示: .*lock\.tmp-test/);
    assert.match(doctor.stdout, /提示: .*old-lock/);

    const fix = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'doctor', '--fix'], {
      cwd: fixture.root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(fix.status, 0, fix.stderr);
    assert.equal(existsSync(lockTmp), false);
    assert.equal(existsSync(trashEntry), false);
    assert.match(fix.stdout, /已删除锁临时目录/);
    assert.match(fix.stdout, /已删除trash 残留/);

    const after = await doctorTasks(fixture.info, false);
    assert.deepEqual(after.problems, []);
    assert.deepEqual(after.notices, []);
  } finally {
    fixture.cleanup();
  }
});

test('损坏的 live 让 doctor 退出非零；--fix 隔离到 trash 后恢复干净', async () => {
  const fixture = makeRepo([meta('t-00a1b2')]);
  try {
    const liveDir = path.join(fixture.state, 'tasks');
    mkdirSync(liveDir, { recursive: true });
    const bad = path.join(liveDir, 't-00a1b2.json');
    writeFileSync(bad, '{ broken', 'utf8');

    const before = await doctorTasks(fixture.info, false);
    assert.ok(before.problems.length >= 1);
    assert.ok(before.problems.some((line) => line.includes('任务状态文件损坏')), before.problems.join(' | '));

    const fix = await doctorTasks(fixture.info, true);
    assert.ok(fix.fixed.some((line) => line.includes('已隔离损坏 live')), fix.fixed.join(' | '));
    assert.equal(existsSync(bad), false);
    const trash = readdirSync(path.join(fixture.state, 'trash'));
    assert.ok(trash.some((name) => name.startsWith('task-t-00a1b2-')));

    const after = await doctorTasks(fixture.info, false);
    assert.deepEqual(after.problems, []);
  } finally {
    fixture.cleanup();
  }
});

test('残留 intent 被报告，--fix 回滚后消失', async () => {
  const fixture = makeRepo([meta('t-00a1b2')]);
  try {
    ensureState(fixture.state);
    transitionTask(fixture.state, 't-00a1b2', 'ready');
    const spec = git(['rev-parse', 'HEAD'], fixture.root);
    const intent: NextIntent = {
      schemaVersion: 1,
      operation_id: 'op-doctor-1',
      task_id: 't-00a1b2',
      lane: 'alpha',
      lane_path: fixture.info.laneTop,
      agent: 'dsh',
      branch: 'main',
      prev: { ...(readTaskLive(fixture.state, 't-00a1b2') as NonNullable<ReturnType<typeof readTaskLive>>) },
      claim_ids: [],
      phase: 'pending',
      created_at: new Date().toISOString(),
    };
    writeIntent(fixture.state, intent);

    const before = await doctorTasks(fixture.info, false);
    assert.ok(before.problems.some((line) => line.includes('残留未完成 next 事务')), before.problems.join(' | '));

    const fix = await doctorTasks(fixture.info, true);
    assert.ok(fix.fixed.some((line) => line.includes('已回滚未完成事务')), fix.fixed.join(' | '));
    const after = await doctorTasks(fixture.info, false);
    assert.deepEqual(after.problems, []);
    assert.equal(readTaskLive(fixture.state, 't-00a1b2')?.status, 'ready', '回滚恢复 prev 的 ready 状态');

    void spec;
  } finally {
    fixture.cleanup();
  }
});

test('依赖不存在与依赖成环都进 doctor 报告', async () => {
  const fixture = makeRepo([
    meta('t-00a1b2', { depends_on: ['t-ffffff'] }),
    meta('t-00b3c4', { depends_on: ['t-00c5d6'] }),
    meta('t-00c5d6', { depends_on: ['t-00b3c4'] }),
  ]);
  try {
    const report = await doctorTasks(fixture.info, false);
    assert.ok(report.problems.some((line) => line.includes('依赖不存在: t-ffffff')), report.problems.join(' | '));
    assert.ok(report.problems.some((line) => line.includes('依赖成环')), report.problems.join(' | '));
  } finally {
    fixture.cleanup();
  }
});

test('spec 文件名与 id 不符、touches 为空会被报告', async () => {
  const fixture = makeRepo(
    [meta('t-00a1b2'), meta('t-00b3c4', { touches: [] })],
    { 't-00a1b2': 'wrong-name.md' },
  );
  try {
    const report = await doctorTasks(fixture.info, false);
    assert.ok(report.problems.some((line) => line.includes('文件名与 id 不符')), report.problems.join(' | '));
    assert.ok(
      report.problems.some((line) => line.includes('touches 不能为空') || line.includes('touches 为空')),
      report.problems.join(' | '),
    );
  } finally {
    fixture.cleanup();
  }
});

test('过期 lease（没有对应占位）被 --fix 回收为 ready', async () => {
  const fixture = makeRepo([meta('t-00a1b2')]);
  try {
    ensureState(fixture.state);
    transitionTask(fixture.state, 't-00a1b2', 'ready');
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      lane: 'alpha',
      lanePath: fixture.info.laneTop,
      agent: 'dsh',
      specCommit: 'deadbeef'.repeat(5),
    });
    const before = await doctorTasks(fixture.info, false);
    assert.ok(before.problems.some((line) => line.includes('内容已漂移')), before.problems.join(' | '));

    const fix = await doctorTasks(fixture.info, true);
    assert.ok(fix.fixed.some((line) => line.includes('已回收过期 lease')), fix.fixed.join(' | '));
    const live = readTaskLive(fixture.state, 't-00a1b2');
    assert.equal(live?.status, 'ready');
    assert.equal(live?.agent, null);
    const after = await doctorTasks(fixture.info, false);
    assert.deepEqual(after.problems, []);
  } finally {
    fixture.cleanup();
  }
});

test('lease 之后改写同一份 spec，祖先检查会漏，blob 比较能报出来', async () => {
  const fixture = makeRepo([meta('t-00a1b2')]);
  try {
    ensureState(fixture.state);
    transitionTask(fixture.state, 't-00a1b2', 'ready');
    const leaseCommit = git(['rev-parse', 'HEAD'], fixture.root);
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      lane: null,
      lanePath: fixture.info.laneTop,
      agent: 'dsh',
      specCommit: leaseCommit,
    });

    // 正常前进：把 spec 的 done_when 改掉并提交，旧 commit 仍是 HEAD 的祖先。
    writeFileSync(
      path.join(fixture.root, '.cowork', 'tasks', 't-00a1b2.md'),
      specText(meta('t-00a1b2', { done_when: ['changed'] })),
      'utf8',
    );
    git(['add', '.'], fixture.root);
    git(['commit', '-qm', 'rewrite spec'], fixture.root);

    const report = await doctorTasks(fixture.info, false);
    assert.ok(
      report.problems.some((line) => line.includes('内容已漂移')),
      report.problems.join(' | '),
    );
  } finally {
    fixture.cleanup();
  }
});

test('同 agent 跑别的任务留下的 claim 不能让 lease 保活', async () => {
  const fixture = makeRepo([meta('t-00a1b2'), meta('t-00b3c4')]);
  try {
    ensureState(fixture.state);
    transitionTask(fixture.state, 't-00a1b2', 'ready');
    const head = git(['rev-parse', 'HEAD'], fixture.root);
    transitionTask(fixture.state, 't-00a1b2', 'claimed', {
      lane: null,
      lanePath: fixture.info.laneTop,
      agent: 'dsh',
      specCommit: head,
    });
    const other = parseClaim('src/t-00b3c4.ts', fixture.info);
    writeClaim(fixture.state, {
      id: claimId(other),
      kind: other.kind,
      key: other.key,
      display: 'src/t-00b3c4.ts',
      lane: null,
      lanePath: fixture.info.laneTop,
      branch: 'main',
      agentId: 'dsh',
      pid: process.pid,
      host: hostname(),
      note: 'task t-00b3c4',
      createdAt: new Date().toISOString(),
      ttlMs: claimTtlMs(),
    });

    const fix = await doctorTasks(fixture.info, true);
    assert.ok(fix.fixed.some((line) => line.includes('已回收过期 lease t-00a1b2')), fix.fixed.join(' | '));
    assert.equal(readTaskLive(fixture.state, 't-00a1b2')?.status, 'ready');
  } finally {
    fixture.cleanup();
  }
});
