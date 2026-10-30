import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CoworkError, EXIT } from '../src/errors.ts';
import type { RepoInfo } from '../src/git.ts';
import { conflicts, parseClaim } from '../src/paths.ts';

const root = mkdtempSync(path.join(tmpdir(), 'cowork-paths-'));
mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
writeFileSync(path.join(root, 'src', 'auth', 'login.ts'), 'export {}\n', 'utf8');
mkdirSync(path.join(root, 'docs'), { recursive: true });
writeFileSync(path.join(root, 'docs', 'a.md'), '# a\n', 'utf8');

const info: RepoInfo = {
  laneTop: root,
  commonDir: path.join(root, '.git'),
  mainRoot: root,
  laneName: null,
};

after(() => rmSync(root, { recursive: true, force: true }));

function codeOf(fn: () => unknown): number {
  try {
    fn();
    return EXIT.OK;
  } catch (err) {
    assert.ok(err instanceof CoworkError, `expected CoworkError, got ${String(err)}`);
    return err.code;
  }
}

test('精确文件路径归一化：分隔符、前导 ./、大小写', () => {
  const a = parseClaim('src/auth/login.ts', info);
  assert.equal(a.kind, 'file');
  assert.equal(a.key, 'src/auth/login.ts');

  const winStyle = './' + ['src', 'auth', 'login.ts'].join(String.fromCharCode(92));
  const b = parseClaim(winStyle, info);
  assert.equal(b.key, a.key, '反斜杠与前导 ./ 都要归一化');
  assert.equal(b.kind, a.kind);

  const c = parseClaim('SRC/Auth/Login.ts', info);
  assert.equal(c.key, a.key, '大小写折叠后冲突键应相同');
  assert.equal(c.display, 'SRC/Auth/Login.ts', '展示形式保留用户输入的大小写');
});

test('目录与 /** 都解析为前缀', () => {
  for (const input of ['src/auth', 'src/auth/**', 'src/auth/']) {
    const parsed = parseClaim(input, info);
    assert.equal(parsed.kind, 'prefix', input);
    assert.equal(parsed.key, 'src/auth', input);
  }
});

test('拒绝绝对路径、盘符、UNC、.. 逃逸与仓库根', () => {
  assert.equal(codeOf(() => parseClaim('D:/repo/src/a.ts', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('/etc/passwd', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('\\\\server\\share\\a.ts', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('../outside.ts', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('src/../../outside.ts', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('.', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('**', info)), EXIT.GENERAL);
  assert.equal(codeOf(() => parseClaim('src/*.ts', info)), EXIT.GENERAL);
});

test('冲突矩阵：文件/文件、文件/前缀、前缀/前缀', () => {
  const fileA = parseClaim('src/auth/login.ts', info);
  const fileB = parseClaim('src/auth/captcha.ts', info);
  const prefix = parseClaim('src/auth', info);
  const parent = parseClaim('src', info);

  assert.equal(conflicts(fileA, fileA), true);
  assert.equal(conflicts(fileA, fileB), false);
  assert.equal(conflicts(fileA, prefix), true);
  assert.equal(conflicts(fileA, parent), true);
  assert.equal(conflicts(prefix, parent), true, '祖先前缀必须冲突');
  assert.equal(conflicts(prefix, fileB), true);
  assert.equal(conflicts(parseClaim('src/authx', info), prefix), false, '前缀按路径段比较，不能吃掉 authx');
});

test('同一相对路径在两条车道里必须得到同一个 key', () => {
  const laneRoot = path.join(root, '.cowork', 'lanes', 'b');
  mkdirSync(path.join(laneRoot, 'src', 'auth'), { recursive: true });
  writeFileSync(path.join(laneRoot, 'src', 'auth', 'login.ts'), 'export {}\n', 'utf8');
  const laneInfo: RepoInfo = { laneTop: laneRoot, commonDir: info.commonDir, mainRoot: root, laneName: 'b' };
  assert.equal(parseClaim('src/auth/login.ts', laneInfo).key, parseClaim('src/auth/login.ts', info).key);
});
