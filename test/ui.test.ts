import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoworkError, EXIT } from '../src/errors.ts';
import type { RepoInfo } from '../src/git.ts';
import type { Snapshot, SnapshotHandoff, SnapshotLane } from '../src/snapshot.ts';
import { escapeHtml, panelPath, renderPanel, watchPanel, writePanel } from '../src/ui.ts';
import { removeTree } from './helpers.ts';

const NO_HANDOFF: SnapshotHandoff = {
  id: null,
  created_at: null,
  title: null,
  path: null,
};

const lanes: SnapshotLane[] = [
  {
    lane: null,
    branch: 'main',
    head: '1111111',
    observed_at: '2026-10-30T08:00:00.000Z',
    dirty: false,
    changed_file_count: 0,
    last_handoff: NO_HANDOFF,
  },
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
    handoff_diagnostics: ['坏文件.md: 缺少 --- 包裹的 JSON front matter', '<bad> 读不了'],
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
  task_diagnostics: [],
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
  task_diagnostics: [],
  claims: [],
  contract_alerts: [],
  lanes: [],
};

test('escapeHtml 转义所有会破坏 HTML 的字符', () => {
  assert.equal(escapeHtml(`<script>"x"&'y'`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  assert.equal(escapeHtml('普通文本'), '普通文本');
  assert.equal(escapeHtml(42), '42', '数字也走同一个入口（pid 渲染）');
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
  assert.ok(html.includes('<ul class="diag">'), '交接单诊断必须出现在面板上');
  assert.ok(html.includes('坏文件.md: 缺少 --- 包裹的 JSON front matter'));
  assert.ok(html.includes('&lt;bad&gt; 读不了'), '诊断内容同样要转义');
  assert.ok(html.includes('pid 42@host'), 'pid 按文本渲染');
});

test('面板呈现车道状态、未提交数量、detached 与过期占位', () => {
  const html = renderPanel(snap);
  assert.ok(html.includes('4 条，1 条有未提交改动'), '工作树计数与 dirty 数');
  assert.ok(html.includes('3 个文件'), 'beta 的变更文件数');
  assert.ok(html.includes('干净'), '干净车道');
  assert.ok(html.includes('(main)'), '主工作树行与它的占位都用 (main) 标出');
  assert.ok(html.includes('detached'), 'detached HEAD 标记');
  assert.ok(html.includes('2 个，其中 1 个已过期'), '占位计数与过期数');
  assert.ok(html.includes('已过期'), '过期占位标记');
});

test('空仓库面板不渲染过滤器，并给出空态说明', () => {
  const html = renderPanel(EMPTY);
  assert.ok(!html.includes('id="filter"'), '没有行时不需要过滤器');
  assert.ok(!html.includes('document.getElementById'), '没有行时不注入过滤脚本');
  assert.ok(html.includes('没有可读的工作树。'));
  assert.ok(html.includes('当前没有占位。'));
  assert.ok(html.includes('还没有任务。'));
});

test('任务卡片渲染状态、阻塞原因、契约提醒与读取诊断', () => {
  const withTasks: Snapshot = {
    ...snap,
    tasks: [
      {
        id: 't-00a1b2',
        title: '<b>alpha</b>',
        status: 'claimed',
        touches: ['src/a/**'],
        reads: [],
        depends_on: ['t-00b3c4'],
        done_when: ['npm test'],
        assigned_lane: 'alpha',
        agent: 'dsh',
        spec_commit: '1234567890abcdef1234567890abcdef12345678',
        updated_at: '2026-10-30T08:00:00.000Z',
        blocked_reason: null,
      },
      {
        id: 't-00c5d6',
        title: 'blocked one',
        status: 'blocked',
        touches: ['src/shared/x.ts'],
        reads: [],
        depends_on: [],
        done_when: [],
        assigned_lane: 'beta',
        agent: 'codex',
        spec_commit: null,
        updated_at: null,
        blocked_reason: '等设计确认 <x>',
      },
    ],
    task_diagnostics: ['t-cccccc.md: 任务规格无效'],
    contract_alerts: [{ kind: 'reads_touches', task: 't-00a1b2', path: 'src/shared/**', peer_task: 't-00c5d6' }],
  };
  const html = renderPanel(withTasks);
  assert.ok(html.includes('2 个，1 个被阻塞，1 条读取失败'), '任务计数与阻塞/诊断汇总');
  assert.ok(html.includes('t-00a1b2'));
  assert.ok(html.includes('&lt;b&gt;alpha&lt;/b&gt;'), '任务标题必须转义');
  assert.ok(html.includes('等设计确认 &lt;x&gt;'), '阻塞原因必须转义');
  assert.ok(html.includes('契约提醒'));
  assert.ok(html.includes('src/shared/**'));
  assert.ok(html.includes('有 1 条任务读取失败'));
  assert.ok(html.includes('1234567'), 'spec_commit 只显示前 7 位');
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
    removeTree(root);
  }
});

test('只有 --watch 渲染 meta refresh，静态面板不自我重载', () => {
  const plain = renderPanel(snap);
  assert.ok(!plain.includes('http-equiv="refresh"'), '静态面板不应自动重载');
  assert.ok(plain.includes('数据截至'), '页头给出数据时间');
  assert.ok(plain.includes('进程停止后不会继续更新。'), '静态面板要说明不会自己更新');
  const watched = renderPanel(snap, { refreshSeconds: 2 });
  assert.ok(watched.includes('<meta http-equiv="refresh" content="2">'));
  assert.ok(watched.includes('每 2 秒自动刷新'));
  assert.ok(watched.includes('watch 每 2 秒重写'));
  assert.ok(watched.includes('Ctrl+C 停止 watch'));
});

test('watchPanel 循环重写同一文件，退出后去掉 refresh，且不留临时文件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cowork-watch-'));
  try {
    const out = path.join(dir, 'panel.html');
    const info: RepoInfo = {
      mainRoot: 'D:\\repo',
      laneTop: 'D:\\repo',
      commonDir: 'D:\\repo\\.git',
      laneName: null,
    };
    const controller = new AbortController();
    const ticks: string[] = [];
    let sequence = 0;
    const file = await watchPanel(info, {
      out,
      intervalMs: 20,
      signal: controller.signal,
      source: async () => {
        sequence += 1;
        return { ...snap, generatedAt: `2026-10-30T08:00:0${sequence}.000Z` };
      },
      onWrite: (_file, _tick, index) => {
        ticks.push(`tick-${index}`);
        if (index === 2) controller.abort();
      },
    });
    assert.equal(file, out);
    assert.deepEqual(ticks, ['tick-1', 'tick-2']);
    const html = readFileSync(out, 'utf8');
    assert.ok(html.includes('4 条'), '写出的确实是面板');
    assert.ok(!html.includes('http-equiv="refresh"'), 'watch 停掉后页面不应继续自动重载');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      '原子写的临时文件必须清理干净',
    );
  } finally {
    removeTree(dir);
  }
});

test('退出前最终采样失败只警告，不把 watch 结果变成失败', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cowork-watch-final-'));
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const out = path.join(dir, 'panel.html');
    const info: RepoInfo = {
      mainRoot: 'D:\\\\repo',
      laneTop: 'D:\\\\repo',
      commonDir: 'D:\\\\repo\\\\.git',
      laneName: null,
    };
    const controller = new AbortController();
    let calls = 0;
    const file = await watchPanel(info, {
      out,
      intervalMs: 20,
      signal: controller.signal,
      source: async () => {
        calls += 1;
        if (calls === 1) return snap;
        throw new Error('收尾采样失败');
      },
      onWrite: (_file, _snap, index) => {
        if (index === 1) controller.abort();
      },
    });
    assert.equal(file, out, '返回最后一次成功写出的路径');
    assert.ok(
      warnings.some((line) => line.includes('退出前写入最终面板失败')),
      `应警告收尾失败，实际: ${warnings.join(' | ')}`,
    );
    // 第一次写入带 refresh；收尾失败后文件保持原样，但进程没有因此报错。
    assert.ok(readFileSync(out, 'utf8').includes('http-equiv="refresh"'));
  } finally {
    console.warn = original;
    removeTree(dir);
  }
});

test('写不出面板文件时按 IO 错误退出 1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cowork-ui-err-'));
  try {
    // 父路径是同名文件：mkdir 必然失败，模拟不可写目标。
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const info: RepoInfo = {
      mainRoot: 'D:\\repo',
      laneTop: 'D:\\repo',
      commonDir: 'D:\\repo\\.git',
      laneName: null,
    };
    assert.throws(
      () => writePanel(info, snap, { out: path.join(blocker, 'panel.html') }),
      (err: unknown) => err instanceof CoworkError && err.code === EXIT.GENERAL,
    );
  } finally {
    removeTree(dir);
  }
});
