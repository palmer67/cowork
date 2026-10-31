import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { renderBoard, renderPanel } from '../src/ui.ts';
import type { Snapshot } from '../src/snapshot.ts';

const snap: Snapshot = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), repo: { root: 'test', head: 'abcdef', trunk: 'main' },
  claims: [], task_diagnostics: [], contract_alerts: [],
  lanes: [{ lane: 'dsh', branch: 'cowork/dsh', head: 'abc123', observed_at: null, dirty: false, changed_file_count: 0, last_handoff: { id: null, title: null, path: null, created_at: null } }],
  tasks: [{ id: 't-123abc', title: '</script><b>payload</b>', status: 'ready', touches: ['src/a.ts'], reads: [], depends_on: [], done_when: [], assigned_lane: null, agent: null, spec_commit: null, updated_at: null, blocked_reason: null }],
};

test('静态操作只复制命令，不包含网络请求与可写表单', () => {
  const html = renderPanel(snap);
  assert.match(html, /复制命令/);
  assert.doesNotMatch(html, /fetch\(|data-api=|<dialog/);
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(script!));
});

test('serve 页面脚本可解析，共享浏览器渲染与服务器渲染逐字相同且转义数据', () => {
  const html = renderPanel(snap, { serve: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  for (const script of scripts) assert.doesNotThrow(() => new Script(script));
  const main = scripts.at(-1)!;
  const source = main.slice(main.indexOf('const HTML_ESCAPES'), main.indexOf('  const token ='));
  const rendered = runInNewContext(source + '\nrenderBoard(snap, { serve: true });', { snap });
  assert.equal(rendered, renderBoard(snap, { serve: true }));
  assert.match(rendered, /&lt;\/script&gt;&lt;b&gt;payload/);
  assert.match(html, /connect-src 'self'/);
  assert.match(main, /document.hidden/);
  assert.match(main, /2000/);
  assert.doesNotMatch(main, /alert\(/);
});

test('按状态禁用动作，车道 error 时禁止派工并提示重开', () => {
  const board = renderBoard({ ...snap, lanes: [{ ...snap.lanes[0]!, error: 'missing' }] }, { serve: true });
  assert.match(board, /disabled title="车道不可用，请核对工作树后重开面板"/);
  assert.match(board, /disabled title="当前 ready；仅 claimed 可用"/);
  assert.match(board, /data-dispatch[^>]*disabled/);
});
