import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTree } from './helpers.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 用法打印不需要仓库：随便一个临时目录即可，顺带证明 help 不会因为「不在仓库里」提前退出 3。
const plain = mkdtempSync(path.join(tmpdir(), 'cowork-cli-help-'));

test('--help 打印用法并退出 0', () => {
  const result = run(['--help'], plain);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /用法/);
  // stderr 里可能有 node 的 ExperimentalWarning，只要求不是未知命令的错误。
  assert.doesNotMatch(result.stderr, /未知命令/);
});

test('-h 等价于 --help', () => {
  const result = run(['-h'], plain);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /用法/);
});

test('help 子命令退出 0，裸 cowork 退出 1', () => {
  assert.equal(run(['help'], plain).status, 0);
  assert.equal(run([], plain).status, 1);
});

test('--version 打印版本并退出 0', () => {
  const result = run(['--version'], plain);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cowork \d+\.\d+\.\d+/);
});

test('未知命令报错并退出 1', () => {
  const result = run(['frobnicate'], plain);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未知命令: frobnicate/);
});

process.on('exit', () => {
  removeTree(plain);
});
