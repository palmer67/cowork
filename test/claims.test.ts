import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { claim, release, status } from '../src/claims.ts';
import { CoworkError, EXIT } from '../src/errors.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';

const root = mkdtempSync(path.join(tmpdir(), 'cowork-claims-'));
const laneDir = path.join(root, '.cowork', 'lanes', 'b');

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

let infoA: RepoInfo;
let infoB: RepoInfo;

before(() => {
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'test'], root);
  writeFileSync(path.join(root, 'README.md'), '# test\n', 'utf8');
  writeFileSync(path.join(root, '.gitignore'), '.cowork/lanes/\n', 'utf8');
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);
  git(['worktree', 'add', '-q', laneDir, '-b', 'lane-b'], root);

  infoA = repoInfo(root);
  infoB = repoInfo(laneDir);
});

after(() => {
  try {
    git(['worktree', 'remove', '--force', laneDir], root);
  } catch {
    // 临时目录随后整体删除，失败无所谓
  }
  rmSync(root, { recursive: true, force: true });
});

async function expectBusy(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof CoworkError, `expected CoworkError, got ${String(err)}`);
    assert.equal(err.code, EXIT.BUSY);
    return true;
  });
}

test('两条车道占同一条相对路径：第二条必须退出 2', async () => {
  await claim(infoA, ['src/auth/login.ts']);
  await expectBusy(() => claim(infoB, ['src/auth/login.ts']));
});

test('目录前缀覆盖车道内文件，且仅按路径段匹配', async () => {
  await claim(infoA, ['src/auth/**']);
  // 完全落在前缀下的文件
  await expectBusy(() => claim(infoB, ['src/auth/types.ts']));
  // 只是名字前缀相同，不是路径前缀
  await claim(infoB, ['src/authx/types.ts']);
});

test('不同路径可以并行占位，status 同时看到两边', async () => {
  await claim(infoB, ['src/ui/captcha.vue']);
  const report = await status(infoA);
  const paths = report.claims.map((rec) => rec.display).sort();
  assert.ok(paths.includes('src/auth/**'), paths.join(','));
  assert.ok(paths.includes('src/ui/captcha.vue'), paths.join(','));
  const lanes = new Set(report.claims.map((rec) => rec.lane));
  assert.equal(lanes.size, 2, '两个车道的占位都应可见');
});

test('release 只释放本车道，且不指定路径时清空本车道', async () => {
  const released = await release(infoA, []);
  assert.ok(released.released.length >= 1);
  const report = await status(infoB);
  assert.equal(report.claims.every((rec) => rec.lane !== null), true);
  assert.ok(report.claims.some((rec) => rec.display === 'src/ui/captcha.vue'));
});

test('同一车道重复占位是续期，不是冲突', async () => {
  const first = await claim(infoB, ['src/ui/captcha.vue']);
  assert.equal(first.claimed.length, 0);
  assert.equal(first.refreshed.length, 1);
});

test('整单失败不会留下半份占位', async () => {
  await claim(infoA, ['src/blocked/x.ts']);
  const before = await status(infoA);
  await expectBusy(() => claim(infoB, ['src/free/y.ts', 'src/blocked/x.ts']));
  const after = await status(infoA);
  assert.equal(after.claims.length, before.claims.length, '失败的调用不能新增任何占位');
  assert.equal(
    after.claims.some((rec) => rec.display === 'src/free/y.ts'),
    false,
    'src/free/y.ts 排在冲突项之前，也不能被写进去',
  );
});

test('同一工作树内不同 agent 视为不同 owner，仍然互斥', async () => {
  process.env['COWORK_AGENT_ID'] = 'codex';
  try {
    await claim(infoA, ['src/shared/thing.ts']);
  } finally {
    process.env['COWORK_AGENT_ID'] = 'dsh';
  }
  try {
    await expectBusy(() => claim(infoA, ['src/shared/thing.ts']));
  } finally {
    delete process.env['COWORK_AGENT_ID'];
  }
});

test('存活只看 TTL：进程退出不影响占位，过期后自动回收', async () => {
  process.env['COWORK_CLAIM_TTL_HOURS'] = '0.0001'; // 360ms
  try {
    await claim(infoB, ['src/ttl/x.ts']);
  } finally {
    delete process.env['COWORK_CLAIM_TTL_HOURS'];
  }
  // 占位进程已退出，但还没过期 → 仍然占着
  await expectBusy(() => claim(infoA, ['src/ttl/x.ts']));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await claim(infoA, ['src/ttl/x.ts']);
  assert.equal(result.claimed.length, 1, '过期后应能重新占位');
  assert.ok(result.pruned.some((rec) => rec.display === 'src/ttl/x.ts'), '过期记录应被回收');
});

test('release --force 允许人拆掉别人的占位，并报告原占用者', async () => {
  await claim(infoA, ['src/forced/thing.ts']);
  const released = await release(infoB, ['src/forced/thing.ts'], { force: true });
  assert.equal(released.released.length, 1);
  assert.equal(released.released[0]?.lanePath, infoA.laneTop);
});
