import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { previewMerge, previewMergeInTemp, renderMergePreview } from '../src/merge.ts';
import { cw, git, lane, makeRepo } from './m3-helpers.ts';

function changeLine(root: string, text: string): void {
  const file = path.join(root, 'shared.txt');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/line 40\r?\n/, `${text}\n`));
  git(['add', 'shared.txt'], root);
  git(['commit', '-qm', text], root);
}

function workingState(root: string) {
  const index = path.resolve(root, git(['rev-parse', '--git-path', 'index'], root));
  return {
    head: git(['rev-parse', 'HEAD'], root),
    refs: git(['for-each-ref', '--format=%(refname) %(objectname)'], root),
    status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
    index: readFileSync(index).toString('hex'),
    shared: readFileSync(path.join(root, 'shared.txt')).toString('hex'),
  };
}

test('merge --dry-run previews two clean lanes, snake_case JSON and an explicit base', () => {
  const fixture = makeRepo('cowork-m3 中文 空格-');
  try {
    for (const name of ['alpha', '中文车道']) {
      const dir = lane(fixture.root, name);
      writeFileSync(path.join(dir, `${name}.txt`), 'new file');
      git(['add', '.'], dir);
      git(['commit', '-qm', 'lane edit'], dir);
      const result = cw(fixture.root, ['merge', '--dry-run', name]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /可合：0 个文件冲突/);
      const json = cw(dir, ['merge', '--dry-run', `dsh/${name}`, '--base', 'main', '--json']);
      assert.equal(json.status, 0, json.stderr);
      const preview = JSON.parse(json.stdout);
      assert.equal(preview.lane, name);
      assert.equal(preview.base_head, git(['rev-parse', 'main'], fixture.root));
      assert.deepEqual(preview.conflicts, []);
    }
    assert.equal(existsSync(fixture.state), false, '只读预演不创建 live');
  } finally { fixture.cleanup(); }
});

test('content conflict gives both side hunk coordinates and keeps HEAD/index/refs/worktrees/live unchanged', () => {
  const fixture = makeRepo();
  try {
    const dir = lane(fixture.root, 'alpha');
    changeLine(fixture.root, 'trunk forty');
    changeLine(dir, 'lane forty');
    writeFileSync(path.join(fixture.root, 'staged.txt'), 'staged');
    git(['add', 'staged.txt'], fixture.root);
    writeFileSync(path.join(fixture.root, 'untracked.txt'), 'untracked');
    writeFileSync(path.join(dir, 'shared.txt'), 'uncommitted\n', { flag: 'a' });
    mkdirSync(path.join(fixture.state, 'lock'), { recursive: true });
    writeFileSync(path.join(fixture.state, 'lock', 'owner.json'), '{"sentinel":true}');
    const before = [workingState(fixture.root), workingState(dir)];
    const result = cw(fixture.root, ['merge', '--dry-run', 'alpha']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /shared\.txt\s+hunk 40-40\s+与 main 的 40-40 重叠/);
    const json = cw(dir, ['merge', '--dry-run', 'alpha', '--json']);
    assert.equal(json.status, 2, json.stderr);
    const preview = JSON.parse(json.stdout);
    assert.deepEqual(preview.conflicts, [{
      path: 'shared.txt', kind: 'content',
      hunks: [{ lane_start: 40, lane_end: 40, base_start: 40, base_end: 40 }],
    }]);
    assert.deepEqual([workingState(fixture.root), workingState(dir)], before);
    assert.equal(readFileSync(path.join(fixture.state, 'lock', 'owner.json'), 'utf8'), '{"sentinel":true}');
    assert.deepEqual(readdirSync(fixture.state), ['lock']);
  } finally { fixture.cleanup(); }
});

test('binary and modify/delete conflicts use whole_file instead of invented line numbers', () => {
  const fixture = makeRepo();
  try {
    writeFileSync(path.join(fixture.root, '图片.bin'), Buffer.from([0, 1, 2]));
    git(['add', '.'], fixture.root); git(['commit', '-qm', 'binary base'], fixture.root);
    const dir = lane(fixture.root, 'binary');
    writeFileSync(path.join(fixture.root, '图片.bin'), Buffer.from([0, 3, 4]));
    git(['rm', 'shared.txt'], fixture.root);
    git(['add', '.'], fixture.root); git(['commit', '-qm', 'base changes'], fixture.root);
    writeFileSync(path.join(dir, '图片.bin'), Buffer.from([0, 5, 6]));
    changeLine(dir, 'lane edit');
    git(['add', '.'], dir); git(['commit', '-qm', 'binary lane'], dir);
    const result = previewMerge(fixture.info, 'binary');
    assert.deepEqual(result.conflicts.map((item) => [item.path, item.kind]), [
      ['shared.txt', 'whole_file'], ['图片.bin', 'whole_file'],
    ]);
    assert.match(renderMergePreview(result), /整文件冲突/);
  } finally { fixture.cleanup(); }
});

test('old Git fallback merges only in system temp and leaves source refs/index untouched', () => {
  const fixture = makeRepo();
  try {
    const dir = lane(fixture.root, 'fallback');
    const base = git(['rev-parse', 'main'], fixture.root);
    writeFileSync(path.join(dir, 'new.txt'), 'new');
    git(['add', '.'], dir); git(['commit', '-qm', 'new'], dir);
    assert.deepEqual(previewMergeInTemp(fixture.info, base, git(['rev-parse', 'HEAD'], dir)), []);
    changeLine(dir, 'lane edit'); changeLine(fixture.root, 'main edit');
    const before = [workingState(fixture.root), workingState(dir)];
    assert.deepEqual(previewMergeInTemp(fixture.info, git(['rev-parse', 'HEAD'], fixture.root), git(['rev-parse', 'HEAD'], dir)), ['shared.txt']);
    assert.deepEqual([workingState(fixture.root), workingState(dir)], before);
    assert.equal(existsSync(fixture.state), false);
  } finally { fixture.cleanup(); }
});

test('merge usage/ref errors exit 1 and non-repository exits 3', () => {
  const fixture = makeRepo();
  try {
    lane(fixture.root, 'alpha');
    for (const args of [[], ['alpha'], ['--dry-run'], ['--dry-run', 'missing'], ['--dry-run', 'alpha', '--base', 'missing'], ['--dry-run', 'alpha', '--base']]) {
      const result = cw(fixture.root, ['merge', ...args]);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    }
    assert.equal(cw(path.dirname(fixture.root), ['merge', '--dry-run', 'alpha']).status, 3);
  } finally { fixture.cleanup(); }
});
