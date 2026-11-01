import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError, EXIT, isLongPathFailure, pathError } from '../src/errors.ts';
import { parseClaim } from '../src/paths.ts';
import { repoInfo } from '../src/git.ts';
import { removeTree } from './helpers.ts';
import { cw, git } from './m3-helpers.ts';

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? files(path.join(root, item.name)) : [path.join(root, item.name)],
  );
}

for (const [name, segments] of [
  ['中文名', ['中文项目']],
  ['空格名', ['project with spaces']],
  ['超过260字符的三层嵌套', ['long-a-'.padEnd(85, 'a'), 'long-b-'.padEnd(85, 'b'), 'long-c-'.padEnd(85, 'c')]],
] as const) {
  test(`Windows 路径：${name} 支持 init / task add / next / status，或长路径优雅退出 3`, () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'cowork-win-'));
    const staging = path.join(temp, 'staging');
    const long = name.startsWith('超过');
    // 长路径在仓库内三层嵌套，不把 Windows 在启动 CLI 前拒绝 cwd 的宿主错误伪装成产品结果。
    const root = long ? path.join(temp, 'repo') : path.join(temp, ...segments);
    try {
      mkdirSync(staging); git(['init', '-q', '-b', 'main'], staging);
      git(['config', 'user.name', 'test'], staging); git(['config', 'user.email', 'test@example.com'], staging);
      git(['config', 'core.longpaths', 'true'], staging);
      writeFileSync(path.join(staging, 'README.md'), '# paths\n');
      git(['add', '.'], staging); git(['commit', '-qm', 'init'], staging);
      mkdirSync(path.dirname(root), { recursive: true }); renameSync(staging, root);
      const init = cw(root, ['init']);
      assert.doesNotMatch(init.stderr, /Error:|\n\s+at /);
      if (long && init.status === 3) {
        assert.match(init.stderr, /路径过长/); assert.match(init.stderr, /可开启 Windows 长路径支持/);
        assert.deepEqual(files(path.join(root, '.cowork')), [], '失败的 init 不应半写配置');
        return;
      }
      assert.equal(init.status, 0, init.stderr);
      const declared = long ? path.posix.join(...segments, '中文 空格.ts') : 'src/中文 空格.ts';
      const target = path.resolve(root, ...declared.split('/'));
      if (long) {
        assert.ok(target.length > 260, `${target.length} characters`);
        const output = path.join(path.dirname(target), 'index.html');
        const panel = cw(root, ['ui', '--out', output]);
        assert.doesNotMatch(panel.stderr, /Error:|\n\s+at /);
        if (panel.status === 3) {
          assert.match(panel.stderr, /路径过长/); assert.match(panel.stderr, /可开启 Windows 长路径支持/);
          assert.deepEqual(files(path.join(root, segments[0])), []);
          assert.equal(existsSync(path.join(root, '.git', 'cowork')), false);
          return;
        }
        assert.equal(panel.status, 0, panel.stderr);
        assert.match(readFileSync(output, 'utf8'), /<!doctype html>/i);
        writeFileSync(target, 'export {};\n');
      }
      const add = cw(root, ['task', 'add', '--title', '中文 空格任务', '--touches', declared]);
      assert.equal(add.status, 0, add.stderr);
      const id = add.stdout.match(/t-[0-9a-f]{6}/)?.[0]; assert.ok(id);
      const specs = files(path.join(root, '.cowork', 'tasks'));
      assert.equal(specs.length, 1); assert.ok(specs[0]?.endsWith(`${id}.md`));
      git(['add', '.'], root); git(['commit', '-qm', 'task spec'], root);
      assert.equal(cw(root, ['task', 'ready', id]).status, 0);
      const next = cw(root, ['next', '--json']); assert.equal(next.status, 0, next.stderr);
      const report = cw(root, ['status', '--json']); assert.equal(report.status, 0, report.stderr);
      const payload = JSON.parse(report.stdout);
      assert.equal(payload.claims.length, 1); assert.equal(payload.tasks.items[0].status, 'claimed');
      const state = path.join(root, '.git', 'cowork');
      assert.equal(files(state).filter((file) => /\.tmp-|intents/.test(file)).length, 0, '没有半截 tmp/intent');
      assert.doesNotMatch([add, next, report].map((result) => result.stderr).join('\n'), /Error:|\n\s+at /);
    } finally { removeTree(temp); }
  });
}

test('长路径错误统一为退出码 3，但不把正常的 >260 以及短 ENOENT 判成失败', () => {
  assert.equal(isLongPathFailure({ code: 'ENOENT', path: 'C:\\missing' }, [], 'win32'), false);
  assert.equal(isLongPathFailure({ code: 'ENOENT', path: `C:\\${'a'.repeat(270)}` }, [], 'win32'), true);
  assert.equal(isLongPathFailure({ code: 'ENOENT', path: `/${'a'.repeat(270)}` }, [], 'linux'), false);
  const error = pathError({ code: 'ENAMETOOLONG' }, path.join(tmpdir(), 'a'.repeat(270)));
  assert.ok(error instanceof CoworkError); assert.equal(error.code, EXIT.ENV);
  assert.match(error.message, /路径过长/); assert.match(error.hint ?? '', /可开启 Windows 长路径支持/);
  const gitFailure = new CoworkError(EXIT.GENERAL, 'fatal: cannot stat file: Filename too long');
  assert.equal(gitFailure.code, 3); assert.match(gitFailure.hint ?? '', /Windows 长路径支持/);
});

test('真实长路径写入失败返回 3，清理临时输出且不创建 live 状态', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'cowork-win-reject-'));
  try {
    git(['init', '-q', '-b', 'main'], temp); git(['config', 'user.name', 'test'], temp);
    git(['config', 'user.email', 'test@example.com'], temp);
    writeFileSync(path.join(temp, 'README.md'), '# paths\n');
    git(['add', '.'], temp); git(['commit', '-qm', 'init'], temp);
    assert.equal(cw(temp, ['init']).status, 0);
    const output = path.join(temp, 'x'.repeat(300), 'index.html');
    const result = cw(temp, ['ui', '--out', output]);
    assert.equal(result.status, 3, result.stderr); assert.match(result.stderr, /路径过长/);
    assert.match(result.stderr, /可开启 Windows 长路径支持/);
    assert.doesNotMatch(result.stderr, /Error:|\n\s+at /);
    assert.deepEqual(files(path.join(temp, 'x'.repeat(300))), []);
    assert.equal(existsSync(path.join(temp, '.git', 'cowork')), false, '只读 snapshot 与失败的面板写入均不建 live');
    // 声明尚未存在的深层文件合法；不因 >260 就提前拒绝。
    const declared = path.posix.join(...Array.from({ length: 3 }, (_, n) => `${n}-${'x'.repeat(90)}`), 'new.ts');
    assert.equal(parseClaim(declared, repoInfo(temp)).display, declared);
    assert.match(readFileSync(path.join(temp, 'README.md'), 'utf8'), /paths/);
  } finally { removeTree(temp); }
});
