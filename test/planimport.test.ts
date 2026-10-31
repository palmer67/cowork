import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importPlan, planFromText } from '../src/planimport.ts';
import type { RepoInfo } from '../src/git.ts';
import { parseTaskSpec } from '../src/tasks.ts';
import { removeTree } from './helpers.ts';

const plan = (tasks: unknown[]): string => JSON.stringify({ schemaVersion: 1, tasks });
const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'login', title: '补登录校验', body: '说明', touches: ['src/auth/login.ts'], reads: [], depends_on: [], done_when: ['npm test'], ...extra,
});

test('解析正常计划并保留依赖别名', () => {
  const tasks = planFromText(plan([base(), base({ key: 'token-migration', title: '迁移 token', touches: ['src/auth/token.ts'] })]));
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0]?.depends_on, []);
});

for (const [name, task] of [
  ['未知 key', base({ depends_on: ['missing'] })],
  ['自依赖', base({ depends_on: ['login'] })],
  ['空 touches', base({ touches: [] })],
  ['重 key', base({ key: 'login' })],
  ['双身份路径', base({ reads: ['src/auth/login.ts'] })],
  ['超长 title', base({ title: 'x'.repeat(121) })],
]) {
  test(`非法计划：${name}`, () => {
    const input = name === '重 key' ? plan([base(), task]) : plan([task]);
    assert.throws(() => planFromText(input), /计划导入失败/);
  });
}

test('依赖环被拒绝', () => {
  assert.throws(() => planFromText(plan([
    base({ key: 'a', depends_on: ['b'] }),
    base({ key: 'b', touches: ['src/b.ts'], depends_on: ['a'] }),
  ])), /依赖图存在环/);
});

test('导入 dry-run 不落盘，正常导入生成全部 draft', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-planimport-'));
  try {
    const file = path.join(root, 'plan.json');
    writeFileSync(file, plan([
      base(),
      base({ key: 'b', title: '第二项', touches: ['src/b.ts'], depends_on: ['login'] }),
      base({ key: 'c', title: '第三项', touches: ['src/c.ts'], depends_on: ['login'] }),
      base({ key: 'd', title: '第四项', touches: ['src/d.ts'], depends_on: ['b', 'c'] }),
    ]));
    const info: RepoInfo = { mainRoot: root, laneTop: root, commonDir: path.join(root, '.git'), laneName: null };
    const preview = await importPlan(info, file, { dryRun: true });
    assert.equal(preview.tasks.length, 4);
    const tasksDir = path.join(root, '.cowork', 'tasks');
    assert.ok(!existsSync(tasksDir), 'dry-run 不应创建 tasks 目录');
    const imported = await importPlan(info, file);
    const files = readdirSync(tasksDir).filter((name) => name.endsWith('.md'));
    assert.equal(files.length, 4);
    const ids = Object.fromEntries(imported.tasks.map((task) => [task.key, task.id]));
    for (const task of imported.tasks) {
      const parsed = parseTaskSpec(readFileSync(task.path, 'utf8'), task.path, info);
      assert.equal(parsed.id, task.id);
      assert.deepEqual(parsed.depends_on, task.depends_on);
      assert.ok(!('key' in parsed.meta), 'key 不能写进 spec');
    }
    assert.deepEqual(imported.tasks[3]!.depends_on, [ids.b, ids.c]);
    assert.ok(!existsSync(path.join(root, '.git', 'cowork', 'tasks')), 'import 不推进 live 状态');
  } finally {
    removeTree(root);
  }
});

test('一次报告同一任务的全部字段错误及根 schema 错误', () => {
  assert.throws(() => planFromText(JSON.stringify({ schemaVersion: 2, tasks: [{ key: '', title: '', touches: [], reads: 1, body: 2, depends_on: 3, done_when: 4 }] })), (err: Error) => {
    for (const field of ['schemaVersion', 'key', 'title', 'touches', 'reads', 'body', 'depends_on', 'done_when']) assert.ok(err.message.includes(field), field);
    return true;
  });
});

test('规范化后同一路径的双身份也被拒绝，零文件写入', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-plan-path-'));
  try {
    const file = path.join(root, 'plan.json');
    writeFileSync(file, plan([base({ touches: ['src/./auth/login.ts'], reads: ['src/auth/login.ts'] })]));
    const info: RepoInfo = { mainRoot: root, laneTop: root, commonDir: path.join(root, '.git'), laneName: null };
    await assert.rejects(importPlan(info, file), /同时出现在/);
    assert.ok(!existsSync(path.join(root, '.cowork', 'tasks')));
  } finally { removeTree(root); }
});

test('CLI 负例各退出 1 且零写入，dry-run 打印路径，ready 仅打印命令', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-plan-cli-'));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  try {
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { windowsHide: true });
    const file = path.join(root, 'plan.json');
    const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', cli, 'task', 'import', file, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    const bad = [
      [base({ depends_on: ['missing'] })], [base({ depends_on: ['login'] })],
      [base({ key: 'a', depends_on: ['b'] }), base({ key: 'b', depends_on: ['a'] })],
      [base({ touches: [] })], [base(), base()], [base({ title: 'x'.repeat(121) })],
      [base({ touches: [false] })], [base({ touches: ['src/a.ts', ''] })], [base({ body: null })],
    ];
    for (const tasks of bad) {
      writeFileSync(file, plan(tasks));
      const result = run();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /计划导入失败/);
      assert.ok(!existsSync(path.join(root, '.cowork', 'tasks')));
    }
    writeFileSync(file, plan([base()]));
    const preview = run('--dry-run', '--ready');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /\.cowork[\\/]tasks[\\/]t-[0-9a-f]{6}\.md/);
    assert.match(preview.stdout, /cowork task ready t-/);
    assert.ok(!existsSync(path.join(root, '.cowork', 'tasks')));
    const imported = run('--ready');
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(readdirSync(path.join(root, '.cowork', 'tasks')).length, 1);
    assert.ok(!existsSync(path.join(root, '.git', 'cowork', 'tasks')));
  } finally { removeTree(root); }
});
