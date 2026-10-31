import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { importPlan, planFromText } from '../src/planimport.ts';
import type { RepoInfo } from '../src/git.ts';

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
    writeFileSync(file, plan([base(), base({ key: 'b', title: '第二项', touches: ['src/b.ts'], depends_on: ['login'] })]));
    const info: RepoInfo = { mainRoot: root, laneTop: root, commonDir: path.join(root, '.git'), laneName: null };
    const preview = await importPlan(info, file, { dryRun: true });
    assert.equal(preview.tasks.length, 2);
    const tasksDir = path.join(root, '.cowork', 'tasks');
    assert.ok(!existsSync(tasksDir), 'dry-run 不应创建 tasks 目录');
    await importPlan(info, file);
    const files = readdirSync(tasksDir).filter((name) => name.endsWith('.md'));
    assert.equal(files.length, 2);
    assert.match(readFileSync(path.join(root, '.cowork', 'tasks', files[0]!), 'utf8'), /schemaVersion/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
