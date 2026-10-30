import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError } from '../src/errors.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import {
  assertTransition,
  checkDependencies,
  createSpec,
  findDependencyCycle,
  listLocalSpecs,
  newTaskId,
  parseTaskSpec,
  readTrunk,
  readTrunkCatalog,
  renderTaskSpec,
  type TaskSpec,
} from '../src/tasks.ts';
import { removeTree } from './helpers.ts';

interface Fixture {
  root: string;
  info: RepoInfo;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-tasks-'));
  mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'export {};\n');
  const info: RepoInfo = {
    laneTop: root,
    commonDir: path.join(root, '.git'),
    mainRoot: root,
    laneName: null,
  };
  return { root, info, cleanup: () => removeTree(root) };
}

function specText(meta: Record<string, unknown>, body = '## 背景\n\n登录页需要验证码。\n'): string {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${body}`;
}

const BASE_META: Record<string, unknown> = {
  schemaVersion: 1,
  id: 't-3f9a1c',
  title: '给登录页加图形验证码',
  touches: ['src/auth/**'],
  reads: ['src/shared/types.ts'],
  depends_on: [],
  done_when: ['npm test'],
  contracts: [],
  created_at: '2026-10-30T16:00:00.000Z',
};

function validSpec(): TaskSpec {
  const fixture = makeFixture();
  try {
    return parseTaskSpec(specText(BASE_META), path.join(fixture.root, 't-3f9a1c.md'), fixture.info);
  } finally {
    fixture.cleanup();
  }
}

test('parseTaskSpec 解析合法 spec，保留未知字段与正文', () => {
  const fixture = makeFixture();
  try {
    const text = specText({ ...BASE_META, priority: 'high' });
    const spec = parseTaskSpec(text, path.join(fixture.root, 't-3f9a1c.md'), fixture.info);
    assert.equal(spec.id, 't-3f9a1c');
    assert.equal(spec.title, '给登录页加图形验证码');
    assert.deepEqual(spec.touches, ['src/auth/**']);
    assert.deepEqual(spec.reads, ['src/shared/types.ts']);
    assert.deepEqual(spec.done_when, ['npm test']);
    assert.deepEqual(spec.contracts, []);
    assert.equal(spec.specCommit, null);
    assert.match(spec.body, /登录页需要验证码/);
    assert.equal(spec.meta['priority'], 'high');
  } finally {
    fixture.cleanup();
  }
});

test('parseTaskSpec 拒绝坏数据并带文件名', () => {
  const fixture = makeFixture();
  const file = path.join(fixture.root, '.cowork', 'tasks', 't-3f9a1c.md');
  const bad = (text: string, pattern: RegExp): void => {
    assert.throws(() => parseTaskSpec(text, file, fixture.info), pattern);
  };
  try {
    bad('# 没有 front matter\n', /任务规格无效.*front matter/);
    bad('---\n{ not json\n---\n', /不是合法 JSON/);
    bad(specText({ ...BASE_META, schemaVersion: 2 }), /schemaVersion 必须是 1/);
    bad(specText({ ...BASE_META, id: 'task-1' }), /id 必须是 t-<6 位十六进制>/);
    bad(specText({ ...BASE_META, title: '   ' }), /title 不能为空/);
    bad(specText({ ...BASE_META, touches: [] }), /touches 不能为空/);
    bad(specText({ ...BASE_META, touches: ['.'] }), /touches 路径无效.*仓库根/);
    bad(specText({ ...BASE_META, touches: ['../escape.ts'] }), /touches 路径无效/);
    bad(specText({ ...BASE_META, created_at: '昨天' }), /created_at 不是合法时间/);
    bad(specText({ ...BASE_META, depends_on: ['t-3f9a1c'] }), /不能引用自己/);
    bad(specText({ ...BASE_META, contracts: 'nope' }), /contracts 必须是数组/);
  } finally {
    fixture.cleanup();
  }
});

test('createSpec 写盘、路径规范化、id 与默认正文', () => {
  const fixture = makeFixture();
  try {
    const spec = createSpec(
      fixture.info,
      {
        title: '给登录页加图形验证码',
        touches: ['src\\auth\\'],
        reads: ['src/shared/types.ts'],
      },
      new Date('2026-10-30T16:00:00.000Z'),
    );
    assert.match(spec.id, /^t-[0-9a-f]{6}$/);
    assert.deepEqual(spec.touches, ['src/auth/**']);
    assert.deepEqual(spec.reads, ['src/shared/types.ts']);
    assert.equal(spec.created_at, '2026-10-30T16:00:00.000Z');
    assert.equal(spec.path, path.join(fixture.root, '.cowork', 'tasks', `${spec.id}.md`));
    assert.ok(existsSync(spec.path ?? ''));
    const reread = parseTaskSpec(readFileSync(spec.path ?? '', 'utf8'), spec.path ?? '', fixture.info);
    assert.equal(reread.id, spec.id);
    assert.deepEqual(reread.touches, spec.touches);
    assert.match(spec.body, /## 背景/);
  } finally {
    fixture.cleanup();
  }
});

test('createSpec 拒绝空标题与空 touches', () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => createSpec(fixture.info, { title: '  ', touches: ['src/auth'] }),
      /任务标题不能为空/,
    );
    assert.throws(
      () => createSpec(fixture.info, { title: '任务', touches: [] }),
      /touches 不能为空/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('newTaskId 不重复且格式固定', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const id = newTaskId('同一标题', '2026-10-30T16:00:00.000Z', ids);
    assert.match(id, /^t-[0-9a-f]{6}$/);
    ids.add(id);
  }
});

test('renderTaskSpec 往返保真，未知字段原样保留', () => {
  const fixture = makeFixture();
  try {
    const file = path.join(fixture.root, 't-3f9a1c.md');
    const spec = parseTaskSpec(specText({ ...BASE_META, priority: 'high' }), file, fixture.info);
    const again = parseTaskSpec(renderTaskSpec(spec), file, fixture.info);
    assert.deepEqual(again.touches, spec.touches);
    assert.deepEqual(again.depends_on, spec.depends_on);
    assert.equal(again.body, spec.body);
    assert.equal(again.meta['priority'], 'high');
  } finally {
    fixture.cleanup();
  }
});

test('状态机：合法链、非法转换、blocked 需要 reason、M2 明确拒绝', () => {
  assert.doesNotThrow(() => assertTransition('draft', 'ready'));
  assert.doesNotThrow(() => assertTransition('ready', 'claimed'));
  assert.doesNotThrow(() => assertTransition('claimed', 'in_progress'));
  assert.doesNotThrow(() => assertTransition('in_progress', 'reported_done'));
  assert.doesNotThrow(() => assertTransition('reported_done', 'merged'));
  assert.doesNotThrow(() => assertTransition('claimed', 'blocked', '等评审'));
  assert.doesNotThrow(() => assertTransition('blocked', 'in_progress'));
  assert.doesNotThrow(() => assertTransition('merged', 'cancelled'));
  assert.throws(() => assertTransition('ready', 'merged'), /非法状态转换: ready → merged/);
  assert.throws(() => assertTransition('merged', 'ready'), /非法状态转换: merged → ready/);
  assert.throws(() => assertTransition('cancelled', 'ready'), /非法状态转换.*终态/);
  assert.throws(() => assertTransition('draft', 'blocked', 'x'), /非法状态转换/);
  assert.throws(() => assertTransition('claimed', 'blocked'), /blocked 必须带 --reason/);
  assert.throws(() => assertTransition('claimed', 'blocked', '  '), /blocked 必须带 --reason/);
  assert.throws(
    () => assertTransition('reported_done', 'verifying'),
    (err: unknown) =>
      err instanceof CoworkError &&
      /M1 没有自动验证态/.test(err.message) &&
      /confirm-merge --manual/.test(err.hint ?? ''),
  );
});

test('依赖成环时打印完整环', () => {
  const a = validSpec();
  const b = { ...validSpec(), id: 't-bbbbbb', depends_on: ['t-3f9a1c'] };
  const aCycle = { ...a, depends_on: ['t-bbbbbb'] };
  const specs = new Map<string, TaskSpec>([
    [aCycle.id, aCycle],
    [b.id, b],
  ]);
  const cycle = findDependencyCycle(aCycle, specs);
  assert.ok(cycle !== null);
  assert.deepEqual(cycle, ['t-3f9a1c', 't-bbbbbb', 't-3f9a1c']);
});

test('checkDependencies 拒绝缺失与已取消的依赖', () => {
  const spec = validSpec();
  const withDep = { ...spec, depends_on: ['t-aaaaaa'] };
  assert.throws(
    () => checkDependencies(withDep, new Map(), () => null),
    /不在 trunk catalog: t-aaaaaa/,
  );
  const depSpec = { ...validSpec(), id: 't-aaaaaa', depends_on: [] };
  assert.throws(
    () => checkDependencies(withDep, new Map([[depSpec.id, depSpec]]), () => 'cancelled'),
    /已取消: t-aaaaaa/,
  );
  assert.doesNotThrow(() =>
    checkDependencies(withDep, new Map([[depSpec.id, depSpec]]), () => 'merged'),
  );
});

test('listLocalSpecs 把坏文件放进诊断，不拖垮列表', () => {
  const fixture = makeFixture();
  try {
    const spec = createSpec(fixture.info, { title: '好任务', touches: ['src/auth'] });
    const dir = path.join(fixture.root, '.cowork', 'tasks');
    writeFileSync(path.join(dir, 't-badbad.md'), '---\n{ nope\n---\n', 'utf8');
    const { specs, diagnostics } = listLocalSpecs(fixture.info);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.id, spec.id);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.file ?? '', /t-badbad\.md$/);
    assert.match(diagnostics[0]?.error ?? '', /任务规格无效/);
  } finally {
    fixture.cleanup();
  }
});

test('readTrunkCatalog 从固定 commit 读 spec 并记录 spec_commit', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-trunk-'));
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  };
  try {
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    mkdirSync(path.join(root, '.cowork', 'tasks'), { recursive: true });
    writeFileSync(
      path.join(root, '.cowork', 'tasks', 't-3f9a1c.md'),
      specText(BASE_META),
      'utf8',
    );
    writeFileSync(path.join(root, 'README.md'), '# repo\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'task spec']);
    const info = repoInfo(root);
    assert.equal(readTrunk(info), 'main');
    const catalog = readTrunkCatalog(info);
    assert.equal(catalog.specs.size, 1);
    assert.equal(catalog.diagnostics.length, 0);
    const spec = catalog.specs.get('t-3f9a1c');
    assert.ok(spec !== undefined);
    assert.equal(spec.specCommit, catalog.rev);
    assert.match(catalog.rev, /^[0-9a-f]{40}$/);
  } finally {
    removeTree(root);
  }
});
