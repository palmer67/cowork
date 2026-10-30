import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { claim } from '../src/claims.ts';
import { CoworkError, EXIT } from '../src/errors.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { parseStatusCount, snapshot, type SnapshotLane } from '../src/snapshot.ts';
import { ensureState, stateRoot } from '../src/store.ts';
import { transitionTask } from '../src/taskstore.ts';
import { removeTree } from './helpers.ts';

const root = mkdtempSync(path.join(tmpdir(), 'cowork-snapshot-'));
const lanesRoot = path.join(root, '.cowork', 'lanes');
const alphaDir = path.join(lanesRoot, 'alpha');
const betaDir = path.join(lanesRoot, 'beta');
const detachDir = path.join(lanesRoot, 'detach');
const goneDir = path.join(lanesRoot, 'gone');

let info: RepoInfo;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function writeHandoff(laneDir: string, name: string, meta: Record<string, unknown>): void {
  const dir = path.join(laneDir, '.cowork', 'notes');
  mkdirSync(dir, { recursive: true });
  // 刻意用多行美化 JSON：历史交接单就是这个格式，解析必须宽容。
  const body = `---\n${JSON.stringify(meta, null, 2)}\n---\n\n# ${meta['task'] ?? name}\n`;
  writeFileSync(path.join(dir, name), body, 'utf8');
}

function laneOf(lanes: readonly SnapshotLane[], lane: string): SnapshotLane {
  const found = lanes.find((entry) => entry.lane === lane);
  assert.ok(found !== undefined, `缺少车道 ${lane}: ${lanes.map((l) => l.lane).join(', ')}`);
  return found;
}

before(() => {
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'test'], root);
  writeFileSync(path.join(root, 'README.md'), '# test\n', 'utf8');
  writeFileSync(path.join(root, 'keep.txt'), 'keep\n', 'utf8');
  writeFileSync(path.join(root, '.gitignore'), '.cowork/lanes/\n', 'utf8');
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);

  git(['worktree', 'add', '-q', '-b', 'feat/alpha', alphaDir], root);
  writeHandoff(alphaDir, '2026-10-30-alpha.md', {
    from: 'seed',
    lane: 'feat/alpha',
    at: '2026-10-30T08:00:00.000Z',
    task: 'alpha 交接',
  });
  git(['add', '-A'], alphaDir);
  git(['commit', '-qm', 'alpha handoff'], alphaDir);

  git(['worktree', 'add', '-q', '-b', 'feat/beta', betaDir], root);
  git(['mv', 'keep.txt', 'kept.txt'], betaDir);
  writeFileSync(path.join(betaDir, 'README.md'), '# test\n\nbeta\n', 'utf8');
  writeFileSync(path.join(betaDir, 'new.txt'), 'new\n', 'utf8');

  git(['worktree', 'add', '-q', '--detach', detachDir], root);

  git(['worktree', 'add', '-q', '--detach', goneDir], root);
  rmSync(goneDir, { recursive: true, force: true });

  info = repoInfo(root);
});

after(() => {
  // 先让 git 自己注销 worktree，再删目录：Windows 上顺序反了会留下锁文件导致 ENOTEMPTY。
  for (const dir of [alphaDir, betaDir, detachDir]) {
    try {
      git(['worktree', 'remove', '--force', dir], root);
    } catch {
      // 目录可能已被测试删除（gone），失败无所谓。
    }
  }
  removeTree(root);
});

test('parseStatusCount：重命名一对只计 1，路径去重，忽略项不计', () => {
  assert.equal(parseStatusCount(''), 0);
  assert.equal(parseStatusCount(' M a.txt\u0000'), 1);
  assert.equal(parseStatusCount('?? x.txt\u0000?? y.txt\u0000'), 2);
  assert.equal(parseStatusCount(' D gone.txt\u0000'), 1);
  assert.equal(parseStatusCount('R  new.txt\u0000old.txt\u0000'), 1);
  assert.equal(parseStatusCount('C  copy.txt\u0000src.txt\u0000 M mod.txt\u0000'), 2);
});

test('枚举 .cowork/lanes 下的 worktree，排序并给出分支、HEAD 与采样时间', async () => {
  const snap = await snapshot(info);
  assert.equal(snap.schemaVersion, 1);
  assert.deepEqual(
    snap.lanes.map((lane) => lane.lane),
    [null, 'alpha', 'beta', 'detach', 'gone'],
    '主工作树（lane=null）排在最前，其余按目录名排序',
  );
  assert.equal(
    realpathSync.native(snap.repo.root).toLowerCase(),
    realpathSync.native(root).toLowerCase(),
  );
  assert.equal(snap.repo.head?.length, 7);
  assert.deepEqual(snap.tasks, []);
  assert.deepEqual(snap.task_diagnostics, []);
  assert.deepEqual(snap.contract_alerts, []);
  for (const lane of snap.lanes) {
    assert.ok(lane.observed_at !== null);
    assert.ok(Number.isFinite(Date.parse(lane.observed_at)), lane.observed_at);
  }
});

test('dirty 与文件数按该车道工作区统计：alpha 干净，beta 含重命名/未跟踪', async () => {
  const snap = await snapshot(info);
  const alpha = laneOf(snap.lanes, 'alpha');
  assert.equal(alpha.branch, 'feat/alpha');
  assert.equal(alpha.dirty, false);
  assert.equal(alpha.changed_file_count, 0);
  assert.equal(alpha.error, undefined);

  const beta = laneOf(snap.lanes, 'beta');
  assert.equal(beta.branch, 'feat/beta');
  assert.equal(beta.dirty, true);
  assert.equal(beta.changed_file_count, 3, 'staged rename + modified + untracked 共 3 个路径');
});

test('主工作树作为 lane=null 的一条纳入，未提交改动照常统计', async () => {
  const clean = await snapshot(info);
  const main = clean.lanes[0];
  assert.ok(main !== undefined);
  assert.equal(main.lane, null);
  assert.equal(main.branch, 'main');
  assert.equal(main.dirty, false);
  assert.equal(main.changed_file_count, 0);

  try {
    writeFileSync(path.join(root, 'README.md'), '# test\n\n主工作树改动\n', 'utf8');
    const dirty = await snapshot(info);
    const changed = dirty.lanes[0];
    assert.ok(changed !== undefined);
    assert.equal(changed.dirty, true, '主工作树（Codex 正在这里干活）的未提交改动必须可见');
    assert.equal(changed.changed_file_count, 1);
  } finally {
    git(['checkout', '--', 'README.md'], root);
  }
});

test('detached HEAD 时 branch 为 null，最近交接全为 null', async () => {
  const snap = await snapshot(info);
  const detach = laneOf(snap.lanes, 'detach');
  assert.equal(detach.branch, null);
  assert.equal(detach.dirty, false);
  assert.deepEqual(detach.last_handoff, {
    id: null,
    created_at: null,
    title: null,
    path: null,
  });
});

test('worktree 目录缺失时给 error，不可得字段是 null 而不是干净', async () => {
  const snap = await snapshot(info);
  const gone = laneOf(snap.lanes, 'gone');
  assert.ok(gone.error?.includes('目录不存在'), gone.error);
  assert.equal(gone.dirty, null);
  assert.equal(gone.changed_file_count, null);
  assert.equal(gone.last_handoff.id, null);
});

test('最近交接按元数据时间倒序；未提交的交接单立即可见', async () => {
  const snap = await snapshot(info);
  const alpha = laneOf(snap.lanes, 'alpha');
  assert.equal(alpha.last_handoff.id, '2026-10-30-alpha');
  assert.equal(alpha.last_handoff.created_at, '2026-10-30T08:00:00.000Z');
  assert.equal(alpha.last_handoff.title, 'alpha 交接');

  // lane 写目录名（beta）而不是分支名，也必须匹配。
  writeHandoff(betaDir, '2026-10-30-beta-later.md', {
    lane: 'beta',
    at: '2026-10-30T09:00:00.000Z',
    task: 'beta 本地交接',
  });
  const afterNote = await snapshot(info);
  const beta = laneOf(afterNote.lanes, 'beta');
  assert.equal(beta.last_handoff.id, '2026-10-30-beta-later');
  assert.equal(beta.last_handoff.created_at, '2026-10-30T09:00:00.000Z');
  assert.equal(beta.changed_file_count, 4, '未提交的交接单本身也算一个变更路径');
});

test('live 状态不存在时不创建目录，claims 为空', async () => {
  assert.equal(existsSync(stateRoot(info)), false, '测试前置：还没有任何占位');
  const snap = await snapshot(info);
  assert.deepEqual(snap.claims, []);
  assert.equal(existsSync(stateRoot(info)), false, '只读快照不能创建 live 状态目录');
});

test('claims 在 mutex 内读取，并带过期计算结果', async () => {
  await claim(info, ['README.md']);
  const snap = await snapshot(info);
  assert.equal(snap.claims.length, 1);
  const record = snap.claims[0];
  assert.ok(record !== undefined);
  assert.equal(record.path, 'README.md');
  assert.equal(record.lane, null);
  assert.equal(record.expired, false);
  assert.ok(Number.isFinite(Date.parse(record.expiresAt)));
  assert.ok(Date.parse(record.expiresAt) > Date.now());
});

test('车道名以 .. 开头不会被当成越界路径过滤', async () => {
  const hidden = path.join(lanesRoot, '..hidden');
  git(['worktree', 'add', '-q', '-b', 'dot-hidden', hidden], root);
  try {
    const snap = await snapshot(info);
    const lane = laneOf(snap.lanes, '..hidden');
    assert.equal(lane.branch, 'dot-hidden');
    assert.equal(lane.dirty, false);
    assert.equal(lane.error, undefined);
  } finally {
    git(['worktree', 'remove', '--force', hidden], root);
  }
});

test('坏 front matter 给出文件级诊断，不把"读不到"显示成"没有交接"', async () => {
  const notes = path.join(betaDir, '.cowork', 'notes');
  const bad = path.join(notes, 'broken.md');
  writeFileSync(bad, '---\n{ not json\n---\n\n# broken\n', 'utf8');
  try {
    const snap = await snapshot(info);
    const beta = laneOf(snap.lanes, 'beta');
    assert.ok(
      beta.handoff_diagnostics?.some((line) => line.startsWith('broken.md:')),
      beta.handoff_diagnostics?.join(' | '),
    );
    // 坏的只是诊断项，前面合法的交接单仍然是最近交接。
    assert.equal(beta.last_handoff.id, '2026-10-30-beta-later');
  } finally {
    rmSync(bad, { force: true });
  }
});

test('交接目录不可读时车道带 error 和诊断，其他字段照常采样', async () => {
  const notesFile = path.join(detachDir, '.cowork', 'notes');
  mkdirSync(path.join(detachDir, '.cowork'), { recursive: true });
  writeFileSync(notesFile, 'not a directory', 'utf8');
  try {
    const snap = await snapshot(info);
    const detach = laneOf(snap.lanes, 'detach');
    assert.ok(detach.error?.includes('无法读取交接目录'), detach.error);
    assert.equal(detach.handoff_diagnostics?.length, 1);
    assert.equal(detach.last_handoff.id, null);
    assert.equal(detach.head?.length, 7, 'Git 字段仍然可用');
  } finally {
    rmSync(notesFile, { force: true });
    rmSync(path.join(detachDir, '.cowork'), { recursive: true, force: true });
  }
});

test('tasks 带 live 状态与 spec_commit，坏 spec 进诊断，contract_alerts 报 reads↔touches', async () => {
  const tasksDir = path.join(root, '.cowork', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const writeSpec = (id: string, meta: Record<string, unknown>): void => {
    writeFileSync(path.join(tasksDir, `${id}.md`), `---
${JSON.stringify(meta, null, 2)}
---

## 背景
`, 'utf8');
  };
  writeSpec('t-aaaaaa', {
    schemaVersion: 1,
    id: 't-aaaaaa',
    title: 'reader',
    touches: ['src/a/**'],
    reads: ['src/shared/**'],
    depends_on: [],
    done_when: ['npm test'],
    contracts: [],
    created_at: '2026-10-30T09:00:00.000Z',
  });
  writeSpec('t-bbbbbb', {
    schemaVersion: 1,
    id: 't-bbbbbb',
    title: 'writer',
    touches: ['src/shared/x.ts'],
    reads: [],
    depends_on: [],
    done_when: [],
    contracts: [],
    created_at: '2026-10-30T10:00:00.000Z',
  });
  writeFileSync(path.join(tasksDir, 't-cccccc.md'), `---
not json
---
`, 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'add task specs'], root);

  ensureState(stateRoot(info));
  transitionTask(stateRoot(info), 't-aaaaaa', 'ready');
  transitionTask(stateRoot(info), 't-bbbbbb', 'ready');

  const snap = await snapshot(info);
  const reader = snap.tasks.find((task) => task.id === 't-aaaaaa');
  const writer = snap.tasks.find((task) => task.id === 't-bbbbbb');
  assert.ok(reader !== undefined);
  assert.ok(writer !== undefined);
  assert.equal(reader.status, 'ready');
  assert.equal(reader.spec_commit?.length, 40);
  assert.deepEqual(reader.reads, ['src/shared/**']);
  assert.equal(writer.depends_on.length, 0);

  assert.ok(
    snap.task_diagnostics.some((line) => line.includes('t-cccccc') && line.includes('任务规格无效')),
    snap.task_diagnostics.join(' | '),
  );
  const alert = snap.contract_alerts.find((item) => item.kind === 'reads_touches');
  assert.ok(alert !== undefined, 'reads 与别的任务 touches 重叠应产生提醒');
  assert.equal(alert.task, 't-aaaaaa');
  assert.equal(alert.peer_task, 't-bbbbbb');
  assert.equal(alert.path, 'src/shared', '提醒里的路径用 parseClaim 的 display');
});

test('claims 目录读不出来时快照 fail closed，不把占位当空集', async () => {
  const state = stateRoot(info);
  ensureState(state);
  rmSync(path.join(state, 'claims'), { recursive: true, force: true });
  writeFileSync(path.join(state, 'claims'), 'not a directory', 'utf8');
  await assert.rejects(
    () => snapshot(info),
    (err: unknown) =>
      err instanceof CoworkError && err.code === EXIT.GENERAL && /任务状态不可读/.test(err.message),
  );
});
