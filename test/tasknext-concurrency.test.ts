import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { ensureState, listClaims, stateRoot } from '../src/store.ts';
import { transitionTask } from '../src/taskstore.ts';
import { listIntents } from '../src/tasknext.ts';
import { removeTree } from './helpers.ts';

interface Fixture {
  root: string;
  info: RepoInfo;
  state: string;
  id: string;
  cleanup: () => void;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

const TASK_ID = 't-00a1b2';
const TOUCHES = ['src/shared/a.ts', 'src/shared/b.ts'];

function makeRepo(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-next-race-'));
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
  const meta = {
    schemaVersion: 1,
    id: TASK_ID,
    title: 'race',
    touches: TOUCHES,
    reads: [],
    depends_on: [],
    done_when: ['npm test'],
    contracts: [],
    created_at: '2026-10-30T10:00:00.000Z',
  };
  writeFileSync(
    path.join(root, '.cowork', 'tasks', `${TASK_ID}.md`),
    `---\n${JSON.stringify(meta, null, 2)}\n---\n\n## 背景\n\n并发测试。\n`,
    'utf8',
  );
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);
  const info = repoInfo(root);
  return { root, info, state: stateRoot(info), id: TASK_ID, cleanup: () => removeTree(root) };
}

function addLane(root: string, name: string): string {
  const dir = path.join(root, '.cowork', 'lanes', name);
  git(['worktree', 'add', dir, '-b', `lane-${name}`], root);
  return dir;
}

const RACER = `import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [barrier, ready, entry, gitEntry, cwd, agent] = process.argv.slice(2);
process.chdir(cwd);
const { next } = await import(pathToFileURL(entry).href);
const { repoInfo } = await import(pathToFileURL(gitEntry).href);
process.env.COWORK_AGENT_ID = agent;

const info = repoInfo(cwd);
fs.writeFileSync(ready, '1');
const t0 = Date.now();
while (!fs.existsSync(barrier)) {
  if (Date.now() - t0 > 20000) process.exit(9);
  await new Promise((resolve) => setTimeout(resolve, 2));
}

try {
  const result = await next(info, {});
  fs.writeFileSync(ready + '.result', JSON.stringify({ code: 0, lane: result.live.lane, agent: result.live.agent }));
  process.exit(0);
} catch (err) {
  const code = typeof err?.code === 'number' ? err.code : 1;
  fs.writeFileSync(ready + '.result', JSON.stringify({ code, message: String(err?.message ?? err) }));
  process.exit(code);
}
`;

interface RacerResult {
  name: string;
  code: number;
  message: string;
}

function runRacer(
  racer: string,
  barrier: string,
  ready: string,
  entry: string,
  gitEntry: string,
  cwd: string,
  agent: string,
  name: string,
): Promise<RacerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', racer, barrier, ready, entry, gitEntry, cwd, agent],
      { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (out += data));
    child.on('error', reject);
    child.on('close', (code) => {
      const file = `${ready}.result`;
      let result: { code?: number; message?: string; lane?: string | null; agent?: string | null } = {};
      if (existsSync(file)) {
        try {
          result = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          result = {};
        }
      }
      resolve({ name, code: code ?? -1, message: result.message ?? out });
    });
  });
}

test('5 个进程同一时刻 next：恰好一个赢家，其余 exit 2，无残留 intent', { timeout: 90_000 }, async () => {
  const fixture = makeRepo();
  const racerDir = mkdtempSync(path.join(tmpdir(), 'cowork-racer-'));
  try {
    ensureState(fixture.state);
    transitionTask(fixture.state, fixture.id, 'ready');

    const entry = fileURLToPath(new URL('../src/tasknext.ts', import.meta.url));
    const gitEntry = fileURLToPath(new URL('../src/git.ts', import.meta.url));
    const racer = path.join(racerDir, 'racer.mjs');
    writeFileSync(racer, RACER, 'utf8');
    const barrier = path.join(racerDir, 'go');

    const names = ['a', 'b', 'c', 'd', 'e'];
    const lanes = names.map((name) => ({ name, cwd: addLane(fixture.root, name) }));
    const ready = lanes.map((lane) => path.join(racerDir, `ready-${lane.name}`));
    const results = lanes.map((lane, index) =>
      runRacer(racer, barrier, ready[index] as string, entry, gitEntry, lane.cwd, `agent-${lane.name}`, lane.name),
    );

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !ready.every((file) => existsSync(file))) {
      await delay(20);
    }
    assert.ok(ready.every((file) => existsSync(file)), '5 个子进程没有全部就位（barrier 超时）');
    writeFileSync(barrier, '1', 'utf8');

    const settled = await Promise.all(results);
    const codes = settled.map((result) => result.code).sort((left, right) => left - right);
    const detail = settled.map((result) => `${result.name}=${result.code}${result.code === 0 ? '' : ` (${result.message.split('\n')[0] ?? ''})`}`).join('\n');

    assert.equal(codes.filter((code) => code === 0).length, 1, `应恰好一个 exit 0，实际：\n${detail}`);
    assert.equal(codes.filter((code) => code === 2).length, 4, `应恰好四个 exit 2，实际：\n${detail}`);

    assert.deepEqual(listIntents(fixture.state), [], '并发 next 后不应留下 intent 文件');
    const claims = listClaims(fixture.state);
    assert.equal(claims.length, TOUCHES.length, `claims 数应等于 touches 数（${TOUCHES.length}），实际 ${claims.length}`);
    const winner = settled.find((result) => result.code === 0);
    assert.ok(winner !== undefined);
    const owners = new Set(claims.map((claim) => claim.lane));
    assert.deepEqual([...owners], [winner.name], 'claims 应全部归赢家车道');
    assert.ok(claims.every((claim) => claim.note === `task ${fixture.id}`), 'claims 的 note 应指向该任务');
  } finally {
    removeTree(racerDir);
    // 先让 git 注销 worktree，再删仓库：Windows 上顺序反了会留下锁文件导致 ENOTEMPTY。
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      try {
        git(['worktree', 'remove', '--force', path.join(fixture.root, '.cowork', 'lanes', name)], fixture.root);
      } catch {
        // 车道可能已被测试删除，失败无所谓。
      }
    }
    try {
      git(['worktree', 'prune'], fixture.root);
    } catch {
      // 仓库已不可用时忽略。
    }
    fixture.cleanup();
  }
});
