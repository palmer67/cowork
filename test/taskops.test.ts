import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError, EXIT } from '../src/errors.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { ensureState, listClaims, stateRoot } from '../src/store.ts';
import { readTaskLive, transitionTask } from '../src/taskstore.ts';
import { readTrunkCatalog } from '../src/tasks.ts';
import {
  addTask,
  blockTask,
  brief,
  cancelTask,
  confirmMerge,
  laneNew,
  listTasks,
  readyTask,
  reportDone,
  showTask,
  startTask,
} from '../src/taskops.ts';
import { next } from '../src/tasknext.ts';
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

function specMeta(
  id: string,
  title: string,
  touches: string[],
  created: string,
  depends: string[] = [],
  reads: string[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    title,
    touches,
    reads,
    depends_on: depends,
    done_when: ['npm test'],
    contracts: [],
    created_at: created,
  };
}

const ALPHA = specMeta('t-00a1b2', 'alpha', ['src/alpha/**'], '2026-10-30T10:00:00.000Z');
const BETA = specMeta('t-00b3c4', 'beta', ['src/beta/**'], '2026-10-30T11:00:00.000Z');

function makeRepo(specs: Record<string, unknown>[]): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-ops-'));
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
  return { root, info, state: stateRoot(info), cleanup: () => removeTree(root) };
}

function markReady(fixture: Fixture, ids: readonly string[]): void {
  ensureState(fixture.state);
  for (const id of ids) transitionTask(fixture.state, id, 'ready');
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

test('task add 只创建 draft spec，touches 规范化，id 形如 t-xxxxxx', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    mkdirSync(path.join(fixture.root, 'src', 'auth'), { recursive: true });
    const spec = await addTask(fixture.info, {
      title: '加验证码',
      touches: ['src/auth', 'src/auth/login.ts'],
      reads: ['src/ui/**'],
      depends_on: [],
      done_when: ['npm test'],
    });
    assert.match(spec.id, /^t-[0-9a-f]{6}$/);
    assert.deepEqual(spec.touches, ['src/auth/**', 'src/auth/login.ts']);
    assert.equal(spec.depends_on.length, 0);
    const file = path.join(fixture.root, '.cowork', 'tasks', `${spec.id}.md`);
    assert.ok(existsSync(file), 'spec 应写盘');
    assert.match(readFileSync(file, 'utf8'), /"title": "加验证码"/);
    // 只写 spec，不建 live
    assert.equal(readTaskLive(fixture.state, spec.id), null);
  } finally {
    fixture.cleanup();
  }
});

test('task add 拒绝空 touches、根路径与未知依赖', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    const err = await expectCode(
      () =>
        addTask(fixture.info, {
          title: 'x',
          touches: [],
          reads: [],
          depends_on: [],
          done_when: [],
        }),
      EXIT.GENERAL,
    );
    assert.match(err.message, /touches/);

    for (const bad of ['.', './', '**', 'src/../..']) {
      await expectCode(
        () =>
          addTask(fixture.info, {
            title: 'x',
            touches: [bad],
            reads: [],
            depends_on: [],
            done_when: [],
          }),
        EXIT.GENERAL,
      );
    }

    const missing = await expectCode(
      () =>
        addTask(fixture.info, {
          title: 'x',
          touches: ['src/x.ts'],
          reads: [],
          depends_on: ['t-ffffff'],
          done_when: [],
        }),
      EXIT.GENERAL,
    );
    assert.match(missing.message, /不在 trunk catalog/);
  } finally {
    fixture.cleanup();
  }
});

test('task add 拒绝已取消的依赖', async () => {
  const fixture = makeRepo([ALPHA, BETA]);
  try {
    ensureState(fixture.state);
    transitionTask(fixture.state, BETA['id'] as string, 'ready');
    transitionTask(fixture.state, BETA['id'] as string, 'cancelled');
    const err = await expectCode(
      () =>
        addTask(fixture.info, {
          title: '依赖已取消',
          touches: ['src/x.ts'],
          reads: [],
          depends_on: [BETA['id'] as string],
          done_when: [],
        }),
      EXIT.GENERAL,
    );
    assert.match(err.message, /已取消/);
  } finally {
    fixture.cleanup();
  }
});

test('task ls 列出 trunk 任务与本地 draft，并支持状态过滤', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    const draft = await addTask(fixture.info, {
      title: '本地草稿',
      touches: ['src/local.ts'],
      reads: [],
      depends_on: [],
      done_when: [],
    });
    const all = await listTasks(fixture.info, null);
    const ids = all.views.map((view) => view.id);
    assert.ok(ids.includes('t-00a1b2'));
    assert.ok(ids.includes(draft.id));
    assert.equal(all.views.find((view) => view.id === 't-00a1b2')?.status, 'draft');

    const onlyDraft = await listTasks(fixture.info, 'draft');
    assert.equal(onlyDraft.views.length, 2);
    const onlyReady = await listTasks(fixture.info, 'ready');
    assert.equal(onlyReady.views.length, 0);

    await expectCode(() => listTasks(fixture.info, 'bogus'), EXIT.GENERAL);
  } finally {
    fixture.cleanup();
  }
});

test('task ready 只接受 trunk 可达的 spec，并记录完整 spec_commit', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    const local = await addTask(fixture.info, {
      title: '未提交草稿',
      touches: ['src/local.ts'],
      reads: [],
      depends_on: [],
      done_when: [],
    });
    const err = await expectCode(() => readyTask(fixture.info, local.id), EXIT.GENERAL);
    assert.match(err.message, /不在 trunk/);

    const live = await readyTask(fixture.info, 't-00a1b2');
    assert.equal(live.status, 'ready');
    assert.equal(live.spec_commit, git(['rev-parse', 'HEAD'], fixture.root));

    // ready 之后 spec 不可改写：再 ready 会被状态机拒绝
    const again = await expectCode(() => readyTask(fixture.info, 't-00a1b2'), EXIT.GENERAL);
    assert.match(again.message, /不能 ready/);
  } finally {
    fixture.cleanup();
  }
});

test('start / report-done / block 检查状态与持有者', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const claimed = await next(fixture.info, { agent: 'alice', lane: 'alpha', lanePath: fixture.info.laneTop });
    assert.equal(claimed.task.id, 't-00a1b2');

    // 别的 agent 不能 start
    const notOwner = await expectCode(() => startTask(fixture.info, 't-00a1b2', 'bob'), EXIT.BUSY);
    assert.match(notOwner.message, /被 lane alpha agent alice 占着/);

    const live = await startTask(fixture.info, 't-00a1b2', 'alice');
    assert.equal(live.status, 'in_progress');

    // 别的 agent 不能续做
    const notOwner2 = await expectCode(() => reportDone(fixture.info, 't-00a1b2', 'bob'), EXIT.BUSY);
    assert.match(notOwner2.message, /占着/);

    const done = await reportDone(fixture.info, 't-00a1b2', 'alice');
    assert.equal(done.status, 'reported_done');

    // report-done 之后不能再 start
    const wrong = await expectCode(() => startTask(fixture.info, 't-00a1b2', 'alice'), EXIT.GENERAL);
    assert.match(wrong.message, /不能 start/);

    // block 需要 reason
    const noReason = await expectCode(() => blockTask(fixture.info, 't-00a1b2', 'alice', '  '), EXIT.GENERAL);
    assert.match(noReason.message, /--reason/);
  } finally {
    fixture.cleanup();
  }
});

test('confirm-merge 要求 --manual + --reason，合并后释放占位', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    await next(fixture.info, { agent: 'alice', lane: 'alpha', lanePath: fixture.info.laneTop });
    await startTask(fixture.info, 't-00a1b2', 'alice');
    await reportDone(fixture.info, 't-00a1b2', 'alice');
    assert.equal(listClaims(fixture.state).length, 1);

    const sha = git(['rev-parse', 'HEAD'], fixture.root);
    const noManual = await expectCode(
      () => confirmMerge(fixture.info, 't-00a1b2', { commit: sha, manual: false, reason: 'ok' }),
      EXIT.GENERAL,
    );
    assert.match(noManual.message, /--manual/);

    const noReason = await expectCode(
      () => confirmMerge(fixture.info, 't-00a1b2', { commit: sha, manual: true, reason: ' ' }),
      EXIT.GENERAL,
    );
    assert.match(noReason.message, /--reason/);

    const badSha = await expectCode(
      () => confirmMerge(fixture.info, 't-00a1b2', { commit: 'deadbeef', manual: true, reason: 'ok' }),
      EXIT.GENERAL,
    );
    assert.match(badSha.message, /无法解析合并提交/);

    const result = await confirmMerge(fixture.info, 't-00a1b2', {
      commit: sha,
      manual: true,
      reason: '人工验证通过',
    });
    assert.equal(result.live.status, 'merged');
    assert.equal(result.live.lane, null);
    assert.deepEqual(result.released, ['src/alpha/**']);
    assert.equal(listClaims(fixture.state).length, 0);

    // 已 merged 不能再 cancel
    await expectCode(() => cancelTask(fixture.info, 't-00a1b2', 'alice', null), EXIT.GENERAL);
  } finally {
    fixture.cleanup();
  }
});

test('cancel 释放占位，之后任务可被依赖方视为不可用', async () => {
  const fixture = makeRepo([ALPHA, BETA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    await next(fixture.info, { agent: 'alice', lane: 'alpha', lanePath: fixture.info.laneTop });
    assert.equal(listClaims(fixture.state).length, 1);
    const result = await cancelTask(fixture.info, 't-00a1b2', 'alice', '方向变了');
    assert.equal(result.live.status, 'cancelled');
    assert.deepEqual(result.released, ['src/alpha/**']);
    assert.equal(listClaims(fixture.state).length, 0);

    // 依赖已取消任务的新 spec 会被拒绝
    const err = await expectCode(
      () =>
        addTask(fixture.info, {
          title: '依赖取消的任务',
          touches: ['src/y.ts'],
          reads: [],
          depends_on: ['t-00a1b2'],
          done_when: [],
        }),
      EXIT.GENERAL,
    );
    assert.match(err.message, /已取消/);
  } finally {
    fixture.cleanup();
  }
});

test('lane new 校验名字与冲突，成功时建 worktree 且在锁外完成', () => {
  const fixture = makeRepo([ALPHA]);
  try {
    for (const bad of ['', 'Bad', 'a/b', '.', '..', 'x'.repeat(33)]) {
      assert.throws(
        () => laneNew(fixture.info, bad, null),
        (err: unknown) => err instanceof CoworkError && err.code === EXIT.GENERAL,
      );
    }
    const result = laneNew(fixture.info, 'auth', null);
    assert.equal(result.branch, 'cowork/auth');
    assert.ok(existsSync(result.path), '车道目录应存在');
    assert.ok(existsSync(path.join(result.path, 'README.md')), '车道应是 checked out 的 worktree');
    assert.equal(git(['rev-parse', '--verify', 'refs/heads/cowork/auth'], fixture.root).length > 0, true);

    // 重名 → exit 2
    assert.throws(
      () => laneNew(fixture.info, 'auth', null),
      (err: unknown) => err instanceof CoworkError && err.code === EXIT.BUSY && /车道已存在/.test(err.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test('brief 汇总本 lane 任务、依赖与硬规则；依赖未满足时标未满足', async () => {
  const fixture = makeRepo([ALPHA, BETA]);
  try {
    // beta 依赖 alpha
    const beta = await addTask(fixture.info, {
      title: 'beta 依赖 alpha',
      touches: ['src/beta.ts'],
      reads: [],
      depends_on: ['t-00a1b2'],
      done_when: ['npm test'],
    });
    git(['add', '.'], fixture.root);
    git(['commit', '-qm', 'add beta'], fixture.root);

    markReady(fixture, ['t-00a1b2']);
    const catalog = readTrunkCatalog(fixture.info);
    const unclaimed = await brief(fixture.info, { agent: 'alice', catalog });
    assert.match(unclaimed, /本 lane 当前没有任务/);
    assert.match(unclaimed, /硬规则: 只改 touches 内的文件/);

    await next(fixture.info, { agent: 'alice', lane: 'alpha', lanePath: fixture.info.laneTop });
    const text = await brief(fixture.info, { agent: 'alice', catalog: readTrunkCatalog(fixture.info) });
    assert.match(text, /本 lane 任务: t-00a1b2 alpha（claimed）/);
    assert.match(text, /src\/alpha\/\*\*/);
    assert.match(text, /本 lane 占位:/);
    assert.match(text, /最近交接单:/);
    assert.equal(beta.id.length, 8);
  } finally {
    fixture.cleanup();
  }
});

test('show 返回 view + spec + live，未知 id exit 1', async () => {
  const fixture = makeRepo([ALPHA]);
  try {
    markReady(fixture, ['t-00a1b2']);
    const shown = await showTask(fixture.info, 't-00a1b2');
    assert.equal(shown.view.status, 'ready');
    assert.equal(shown.view.title, 'alpha');
    assert.equal(shown.live?.status, 'ready');

    const err = await expectCode(() => showTask(fixture.info, 't-abcdef'), EXIT.GENERAL);
    assert.match(err.message, /找不到任务/);
  } finally {
    fixture.cleanup();
  }
});

test('e2e: add → ready → next → start → report-done → confirm-merge 后依赖方可领', async () => {
  const fixture = makeRepo([]);
  try {
    const first = await addTask(fixture.info, {
      title: '第一个',
      touches: ['src/first/**'],
      reads: [],
      depends_on: [],
      done_when: ['npm test'],
    });
    git(['add', '.'], fixture.root);
    git(['commit', '-qm', 'add first spec'], fixture.root);

    const second = await addTask(fixture.info, {
      title: '第二个',
      touches: ['src/second/**'],
      reads: [],
      depends_on: [first.id],
      done_when: ['npm test'],
    });
    git(['add', '.'], fixture.root);
    git(['commit', '-qm', 'add second spec'], fixture.root);

    await readyTask(fixture.info, first.id);
    await readyTask(fixture.info, second.id);
    // second 依赖 first 未 merged，next 只能领 first
    const got = await next(fixture.info, { agent: 'alice', lane: 'alpha', lanePath: fixture.info.laneTop });
    assert.equal(got.task.id, first.id);

    const blocked = await expectCode(
      () => next(fixture.info, { agent: 'bob', lane: 'beta', lanePath: fixture.info.laneTop }),
      EXIT.GENERAL,
    );
    assert.match(blocked.message, /尚未 merged|依赖/);

    await startTask(fixture.info, first.id, 'alice');
    await reportDone(fixture.info, first.id, 'alice');
    const sha = git(['rev-parse', 'HEAD'], fixture.root);
    await confirmMerge(fixture.info, first.id, { commit: sha, manual: true, reason: '人工验收' });

    const gotSecond = await next(fixture.info, { agent: 'bob', lane: 'beta', lanePath: fixture.info.laneTop });
    assert.equal(gotSecond.task.id, second.id);
    assert.equal(gotSecond.live.status, 'claimed');
  } finally {
    fixture.cleanup();
  }
});
