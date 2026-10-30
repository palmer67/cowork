import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RepoInfo } from '../src/git.ts';
import type { Snapshot, SnapshotHandoff, SnapshotLane } from '../src/snapshot.ts';
import { escapeHtml, panelPath, renderPanel, writePanel } from '../src/ui.ts';

const NO_HANDOFF: SnapshotHandoff = {
  id: null,
  created_at: null,
  title: null,
  path: null,
};

const lanes: SnapshotLane[] = [
  {
    lane: 'alpha',
    branch: 'feat/alpha',
    head: 'abc1234',
    observed_at: '2026-10-30T08:00:00.000Z',
    dirty: true,
    changed_file_count: 3,
    last_handoff: {
      id: '2026-10-30-alpha',
      created_at: '2026-10-30T08:00:00.000Z',
      title: '<b>交接</b>',
      path: 'notes/2026-10-30-alpha.md',
    },
  },
  {
    lane: 'detach',
    branch: null,
    head: 'def5678',
    observed_at: '2026-10-30T08:00:00.000Z',
    dirty: false,
    changed_file_count: 0,
    last_handoff: NO_HANDOFF,
  },
  {
    lane: 'gone',
    branch: 'feat/gone',
    head: null,
    observed_at: null,
    dirty: null,
    changed_file_count: null,
    last_handoff: NO_HANDOFF,
    error: '车道目录不存在 <bad>',
  },
];

const snap: Snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-10-30T08:00:00.000Z',
  repo: { root: 'D:\\repo', head: 'abc1234' },
  tasks: [],
  claims: [
    {
      path: 'src/<x>.ts',
      kind: 'file',
      lane: 'alpha',
      branch: 'feat/alpha',
      agent: 'dsh',
      pid: 42,
      host: 'host',
      note: '<script>alert(1)</script>',
      createdAt: '2026-10-30T08:00:00.000Z',
      expiresAt: '2026-10-31T08:00:00.000Z',
      expired: false,
    },
    {
      path: 'src/lib/**',
      kind: 'prefix',
      lane: null,
      branch: 'main',
      agent: 'default',
      pid: 7,
      host: 'host',
      note: null,
      createdAt: '2026-10-28T08:00:00.000Z',
      expiresAt: '2026-10-29T08:00:00.000Z',
      expired: true,
    },
  ],
  contract_alerts: [],
  lanes,
};

const EMPTY: Snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-10-30T08:00:00.000Z',
  repo: { root: 'D:\\repo', head: null },
  tasks: [],
  claims: [],
  contract_alerts: [],
  lanes: [],
};

test('escapeHtml 转义所有会破坏 HTML 的字符', () => {
  assert.equal(escapeHtml(`<script>"x"&'y'`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  assert.equal(escapeHtml('普通文本'), '普通文本');
});

test('面板数据全部转义：占位备注、交接标题、错误信息都不能变成标记', () => {
  const html = renderPanel(snap);
  assert.ok(html.startsWith('<!doctype html>'), '应是完整 HTML 文档');
  assert.ok(html.includes('Content-Security-Policy'), '必须声明 CSP');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)'), '备注必须转义，不能执行');
  assert.ok(html.includes('&lt;b&gt;交接&lt;/b&gt;'), '交接标题必须转义');
  assert.ok(html.includes('车道目录不存在 &lt;bad&gt;'), '错误信息必须转义');
  assert.ok(html.includes('src/&lt;x&gt;.ts'), '占位路径必须转义');
});

test('面板呈现车道状态、未提交数量、detached 与过期占位', () => {
  const html = renderPanel(snap);
  assert.ok(html.includes('3 条，1 条有未提交改动'), '车道计数与 dirty 数');
  assert.ok(html.includes('3 个文件'), 'beta 的变更文件数');
  assert.ok(html.includes('干净'), '干净车道');
  assert.ok(html.includes('detached'), 'detached HEAD 标记');
  assert.ok(html.includes('2 个，其中 1 个已过期'), '占位计数与过期数');
  assert.ok(html.includes('已过期'), '过期占位标记');
  assert.ok(html.includes('(主工作树)'), '全局占位的车道列');
});

test('空仓库面板不渲染过滤器，并给出空态说明', () => {
  const html = renderPanel(EMPTY);
  assert.ok(!html.includes('id="filter"'), '没有行时不需要过滤器');
  assert.ok(!html.includes('document.getElementById'), '没有行时不注入过滤脚本');
  assert.ok(html.includes('没有登记的车道。'));
  assert.ok(html.includes('当前没有占位。'));
  assert.ok(html.includes('任务层还没实现'));
});

test('panelPath 按 commonDir 稳定，writePanel 落盘且内容与渲染一致', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-ui-'));
  try {
    const a: RepoInfo = {
      mainRoot: 'D:\\repo',
      laneTop: 'D:\\repo\\lane',
      commonDir: 'D:\\repo\\.git',
      laneName: 'lane',
    };
    const b: RepoInfo = { ...a, commonDir: 'D:\\repo2\\.git' };
    const first = panelPath(a);
    assert.equal(panelPath(a), first);
    assert.notEqual(panelPath(b), first);
    assert.ok(first.endsWith(path.join('index.html')));

    const out = path.join(root, 'nested', 'panel.html');
    const written = writePanel(a, snap, { out });
    assert.equal(written, out);
    assert.equal(readFileSync(out, 'utf8'), renderPanel(snap));

    const direct = writePanel(a, snap);
    assert.equal(direct, panelPath(a));
    assert.ok(existsSync(direct));
    rmSync(direct, { force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
