import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { claim } from '../src/claims.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { parseStatusCount, snapshot, type SnapshotLane } from '../src/snapshot.ts';
import { stateRoot } from '../src/store.ts';

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
  rmSync(root, { recursive: true, force: true });
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
    ['alpha', 'beta', 'detach', 'gone'],
  );
  assert.equal(
    realpathSync.native(snap.repo.root).toLowerCase(),
    realpathSync.native(root).toLowerCase(),
  );
  assert.equal(snap.repo.head?.length, 7);
  assert.deepEqual(snap.tasks, []);
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
  assert.ok(gone.error?.includes('车道目录不存在'), gone.error);
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
