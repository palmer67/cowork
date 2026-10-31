import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { buildContractAlerts, type ContractTask } from '../src/contracts.ts';
import { readHandoffs } from '../src/handoffs.ts';
import { repoInfo, type RepoInfo } from '../src/git.ts';
import { removeTree } from './helpers.ts';

const root = mkdtempSync(path.join(tmpdir(), 'cowork-contracts-'));
const notes = path.join(root, '.cowork', 'notes');
let info: RepoInfo;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
}

function writeHandoff(name: string, metadata: Record<string, unknown>): void {
  writeFileSync(path.join(notes, name), `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n# handoff\n`, 'utf8');
}

before(() => {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(path.join(root, 'README.md'), '# test\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  mkdirSync(notes, { recursive: true });
  info = repoInfo(root);
});

beforeEach(() => {
  rmSync(notes, { recursive: true, force: true });
  mkdirSync(notes, { recursive: true });
});

after(() => removeTree(root));

test('contract alerts normalize paths, keep source, expand all three kinds, and deduplicate', () => {
  writeHandoff('api.md', {
    lane: 'writer-lane',
    task_id: 't-writer1',
    contracts_changed: [
      { paths: ['.\\src\\api\\**', 'schemas/task.json'], old: 'TaskV1', new: 'TaskV2', compatibility: '兼容读取', affected_tasks: ['t-reader1'] },
      { paths: ['./src/api/**'], old: 'duplicate' },
    ],
  });
  const tasks: ContractTask[] = [
    { id: 't-reader1', status: 'ready', reads: ['src/api/client.ts', 'src/api2/client.ts'], touches: [], assigned_lane: 'reader-lane' },
    { id: 't-writer1', status: 'in_progress', reads: [], touches: ['src/api/client.ts', 'schemas/task.json'], assigned_lane: 'writer-lane' },
  ];
  const read = readHandoffs(notes, info);
  assert.deepEqual(read.diagnostics, []);
  const alerts = buildContractAlerts(info, tasks, read.metas);
  assert.equal(alerts.filter((item) => item.kind === 'reads_contract').length, 1);
  assert.equal(alerts.filter((item) => item.kind === 'touches_contract').length, 2);
  assert.equal(alerts.filter((item) => item.kind === 'reads_touches').length, 1);
  assert.ok(!alerts.some((item) => item.task === 't-reader1' && item.path === 'src/api2'));
  const apiAlert = alerts.find((item) => item.kind === 'reads_contract');
  assert.ok(apiAlert !== undefined);
  assert.equal(apiAlert.path, 'src/api');
  assert.equal(apiAlert.peer_task, 't-writer1');
  assert.equal(apiAlert.peer_lane, 'writer-lane');
  assert.equal(apiAlert.handoff_path, path.join(notes, 'api.md'));
  assert.match(apiAlert.summary, /TaskV1 → TaskV2/);
});

test('missing contracts_changed is empty; invalid contracts_changed.paths is diagnosed', () => {
  writeHandoff('no-contract.md', { lane: 'plain-lane' });
  writeHandoff('bad-contract.md', {
    lane: 'bad-lane',
    contracts_changed: [{ paths: ['../outside.ts'] }],
  });
  const read = readHandoffs(notes, info);
  assert.equal(read.metas.find((item) => item.id === 'no-contract')?.contracts_changed.length, 0);
  assert.ok(read.diagnostics.some((line) => line.includes('bad-contract.md') && line.includes('路径无效')));
  assert.deepEqual(
    buildContractAlerts(info, [
      { id: 't-reader1', status: 'ready', reads: ['src/api/client.ts'], touches: [], assigned_lane: null },
    ], read.metas),
    [],
  );
});
