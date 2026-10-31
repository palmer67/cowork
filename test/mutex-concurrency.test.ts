import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const racer = path.join(repoRoot, 'tools', 'mutex-racer.mjs');
const root = mkdtempSync(path.join(tmpdir(), 'cowork-mutex-race-'));
const RUNNERS = 4;
const ROUNDS = 15;

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

function runRacer(state: string, counter: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', racer, state, counter, String(ROUNDS)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: null, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test(
  '4 个进程同时抢锁：没有 EPERM/ENOENT 退出，counter 不丢更新',
  { timeout: 180_000 },
  async () => {
    const state = path.join(root, 'state');
    const counter = path.join(root, 'counter');
    writeFileSync(counter, '0', 'utf8');

    const results = await Promise.all(
      Array.from({ length: RUNNERS }, () => runRacer(state, counter)),
    );

    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0, 0, 0],
      `所有进程都应以 0 退出；stderr: ${results.map((result) => result.stderr).join(' | ')}`,
    );
    for (const result of results) {
      assert.doesNotMatch(result.stderr, /EPERM|ENOENT|无法创建锁目录|无法写入 owner\.json/);
    }
    assert.equal(
      Number(readFileSync(counter, 'utf8')),
      RUNNERS * ROUNDS,
      '计数少一个就说明读-改-写没有互斥',
    );
    assert.equal(existsSync(path.join(state, 'lock')), false, '结束后不能留下锁目录');
    assert.deepEqual(
      readdirSync(state).filter((name) => name.startsWith('lock.tmp-')),
      [],
      '不能留下临时锁目录',
    );
  },
);
