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

function ownedTask(id: string, status: string) {
  return { ...snap.tasks[0]!, id, status, assigned_lane: 'dsh', agent: 'dsh' };
}

function actionMarkup(board: string, id: string, action: string): string {
  const needle = `data-api="/api/task/${id}/${action}"`;
  const at = board.indexOf(needle);
  assert.notEqual(at, -1, `missing ${needle}`);
  const start = board.lastIndexOf('<button', at);
  const end = board.indexOf('</button>', at) + '</button>'.length;
  return board.slice(start, end);
}

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

test('按状态与 owner 禁用动作；ready/confirm-merge 不受 owner 限制', () => {
  const invalidLaneBoard = renderBoard({ ...snap, lanes: [{ ...snap.lanes[0]!, error: 'missing' }] }, { serve: true });
  assert.match(invalidLaneBoard, /disabled title="车道不可用，请核对工作树后重开面板"/);
  assert.match(invalidLaneBoard, /disabled title="当前 ready；仅 claimed 可用"/);
  assert.match(invalidLaneBoard, /data-dispatch[^>]*disabled/);
  const tasks = [
    ownedTask('t-start01', 'claimed'), ownedTask('t-report1', 'in_progress'),
    ownedTask('t-block01', 'in_progress'), ownedTask('t-cancel1', 'claimed'),
    ownedTask('t-ready01', 'draft'), ownedTask('t-merge01', 'reported_done'),
  ];
  const board = renderBoard({ ...snap, panel_agent: 'panel-operator', tasks }, { serve: true });
  for (const [id, action] of [['t-start01', 'start'], ['t-report1', 'report-done'], ['t-block01', 'block'], ['t-cancel1', 'cancel']]) {
    assert.match(actionMarkup(board, id, action), /disabled title="需在车道 dsh 内由 dsh 执行"/);
  }
  assert.match(board, /<code class="mono">cowork task start t-start01<\/code>/);
  assert.match(board, /data-copy="cowork task start t-start01"/);
  assert.doesNotMatch(actionMarkup(board, 't-ready01', 'ready'), /\sdisabled(?:\s|>)/);
  assert.doesNotMatch(actionMarkup(board, 't-merge01', 'confirm-merge'), /\sdisabled(?:\s|>)/);
  const matching = renderBoard({ ...snap, panel_agent: 'dsh', tasks: [ownedTask('t-owned01', 'claimed')] }, { serve: true });
  assert.doesNotMatch(actionMarkup(matching, 't-owned01', 'start'), /\sdisabled(?:\s|>)/);
  const mainOwner = renderBoard({ ...snap, panel_agent: 'panel-operator', tasks: [{ ...snap.tasks[0]!, id: 't-main01', status: 'claimed', assigned_lane: null, agent: 'main-agent' }] }, { serve: true });
  assert.match(mainOwner, /\(main\)/);
  assert.match(actionMarkup(mainOwner, 't-main01', 'start'), /disabled title="需在车道 \(main\) 内由 main-agent 执行"/);
  const undeclared = renderBoard({ ...snap, panel_agent: 'panel-operator', tasks: [{ ...snap.tasks[0]!, id: 't-undecl', status: 'claimed', assigned_lane: 'dsh', agent: null }] }, { serve: true });
  assert.match(undeclared, /未声明/);
  assert.match(actionMarkup(undeclared, 't-undecl', 'start'), /disabled title="需在车道 dsh 内由 未声明 执行"/);
});
