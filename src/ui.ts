import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { general } from './errors.ts';
import type { RepoInfo } from './git.ts';
import { snapshot } from './snapshot.ts';
import type { ContractAlert } from './contracts.ts';
import type {
  Snapshot,
  SnapshotClaim,
  SnapshotHandoff,
  SnapshotLane,
  SnapshotTask,
} from './snapshot.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 所有进入 HTML 的数据都必须先过这里；面板是纯文本表格，不拼接任何 URL。 */
export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function localTime(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function badge(text: string, tone?: 'ok' | 'warn' | 'bad'): string {
  return `<span class="badge${tone === undefined ? '' : ` ${tone}`}">${escapeHtml(text)}</span>`;
}

function changesCell(lane: SnapshotLane): string {
  if (lane.dirty === null) return '<span class="sub">—</span>';
  if (!lane.dirty) return badge('干净', 'ok');
  return badge(`${lane.changed_file_count ?? 0} 个文件`, 'warn');
}

function handoffCell(handoff: SnapshotHandoff): string {
  if (handoff.id === null) return '<span class="sub">—</span>';
  const title = handoff.title === null ? '' : `<div>${escapeHtml(handoff.title)}</div>`;
  const when = handoff.created_at === null ? '' : ` · ${escapeHtml(localTime(handoff.created_at))}`;
  return `${title}<div class="sub mono">${escapeHtml(handoff.id)}${when}</div>`;
}

/** 交接单读取诊断：哪份文件、什么原因，不能把"读不到"显示成"没有"。 */
function diagnosticsCell(lane: SnapshotLane): string {
  const lines = lane.handoff_diagnostics;
  if (lines === undefined || lines.length === 0) return '';
  return `<ul class="diag">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
}

function actionButton(label: string, route: string, command: string, serve: boolean, reason = '', form = ''): string {
  if (!serve || route === '') {
    const copyLabel = label === '' ? '复制命令' : label;
    return `<button type="button" data-copy="${escapeHtml(command)}" title="${escapeHtml(command)}">${escapeHtml(copyLabel)}</button>`;
  }
  return `<button type="button" data-api="${escapeHtml(route)}" data-command="${escapeHtml(command)}"${form === '' ? '' : ` data-form="${escapeHtml(form)}"`}${reason === '' ? '' : ` disabled title="${escapeHtml(reason)}"`}>${escapeHtml(label)}</button>`;
}

function renderLanes(lanes: readonly SnapshotLane[], options: RenderOptions = {}): string {
  if (lanes.length === 0) {
    return '<p class="empty">没有可读的工作树。git worktree list 应至少包含主工作树。</p>';
  }
  const rows = lanes
    .map((lane) => {
      const label = lane.lane === null ? '(main)' : lane.lane;
      const err =
        lane.error === undefined
          ? ''
          : `<tr class="err-row"><td colspan="7"><p class="err">${escapeHtml(lane.error)}</p></td></tr>`;
      const branch =
        lane.branch === null
          ? badge('detached', 'warn')
          : `<span class="mono">${escapeHtml(lane.branch)}</span>`;
      const head =
        lane.head === null
          ? '<span class="sub">—</span>'
          : `<span class="mono">${escapeHtml(lane.head)}</span>`;
      const observed =
        lane.observed_at === null
          ? '<span class="sub">—</span>'
          : `<span class="sub mono">${escapeHtml(localTime(lane.observed_at))}</span>`;
      return `<tr>
  <td><span class="mono">${escapeHtml(label)}</span></td>
  <td>${branch}</td>
  <td>${head}</td>
  <td>${changesCell(lane)}</td>
  <td>${handoffCell(lane.last_handoff)}${diagnosticsCell(lane)}</td>
  <td>${observed}</td>
  <td class="actions">${lane.lane === null ? (options.serve ? '<span class="sub">主工作树</span>' : actionButton('', '', 'cowork snapshot --json', false)) : (() => {
    const route = `/api/lane/${encodeURIComponent(lane.lane)}/next`;
    const command = options.serve ? `cowork next --agent ${lane.lane}  (cwd: .cowork/lanes/${lane.lane})` : `cd ${JSON.stringify(`.cowork/lanes/${lane.lane}`)}; cowork next --agent ${lane.lane}`;
    const invalidName = !/^[A-Za-z0-9._-]+$/.test(lane.lane);
    const reason = lane.error !== undefined || invalidName ? '车道不可用，请核对工作树后重开面板' : '';
    const next = actionButton('在此车道派工', route, command, options.serve === true, reason);
    const briefCommand = options.serve ? `cowork brief --agent ${lane.lane}` : `cd ${JSON.stringify(`.cowork/lanes/${lane.lane}`)}; cowork brief --agent ${lane.lane}`;
    const brief = actionButton('查看 brief', `/api/brief?lane=${encodeURIComponent(lane.lane)}`, briefCommand, options.serve === true, reason);
    return next + brief;
  })()}</td>
</tr>${err}`;
    })
    .join('');
  return `<table>
<thead><tr><th>车道</th><th>分支</th><th>HEAD</th><th>未提交</th><th>最近交接</th><th>采样时间</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderClaims(claims: readonly SnapshotClaim[]): string {
  if (claims.length === 0) {
    return '<p class="empty">当前没有占位。agent 运行 cowork claim &lt;路径&gt; 占位后会出现在这里。</p>';
  }
  const rows = claims
    .map((claim) => {
      const lane =
        claim.lane === null
          ? '<span class="sub">(main)</span>'
          : `<span class="mono">${escapeHtml(claim.lane)}</span>`;
      const note =
        claim.note === null
          ? '<span class="sub">—</span>'
          : `<div class="note">${escapeHtml(claim.note)}</div>`;
      const expires = claim.expired
        ? badge('已过期', 'bad')
        : `<span class="sub mono">${escapeHtml(localTime(claim.expiresAt))}</span>`;
      return `<tr>
  <td><span class="mono">${escapeHtml(claim.path)}</span></td>
  <td>${badge(claim.kind === 'prefix' ? '目录' : '文件')}</td>
  <td>${lane}</td>
  <td>${escapeHtml(claim.agent)}<div class="sub mono">pid ${escapeHtml(claim.pid)}@${escapeHtml(claim.host)}</div></td>
  <td>${note}</td>
  <td>${expires}</td>
</tr>`;
    })
    .join('');
  return `<table>
<thead><tr><th>路径</th><th>类型</th><th>车道</th><th>占用者</th><th>备注</th><th>过期时间</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

const STATUS_TONES: Record<string, 'ok' | 'warn' | 'bad' | undefined> = {
  merged: 'ok',
  cancelled: 'bad',
  blocked: 'bad',
  verify_failed: 'bad',
  awaiting_merge: 'ok',
  verifying: 'warn',
  reported_done: 'warn',
  in_progress: 'warn',
  ready: 'warn',
};

function statusBadge(status: string): string {
  return badge(status, STATUS_TONES[status]);
}

function taskActions(task: SnapshotTask, lanes: readonly SnapshotLane[], options: RenderOptions): string {
  if (!options.serve) {
    const retry = task.status === 'verify_failed' || (task.status === 'reported_done' && task.verification?.status === 'failed');
    const action = task.status === 'draft' || task.status === 'blocked' ? 'ready' : task.status === 'claimed' ? 'start' : task.status === 'in_progress' ? 'report-done' : task.status === 'reported_done' || task.status === 'verify_failed' ? 'done' : task.status === 'awaiting_merge' ? 'confirm-merge' : 'show';
    const label = retry ? '重跑验证' : task.status === 'reported_done' ? '运行验证' : '';
    return actionButton(label, '', `cowork task ${action} ${task.id}${action === 'confirm-merge' ? ' --commit <sha>' : ''}`, false);
  }
  const invalidLane = task.assigned_lane === null ? false : !lanes.some((lane) => lane.lane === task.assigned_lane && lane.error === undefined);
  const definitions: [string, string, string[]][] = [
    ['ready', '审核就绪', ['draft', 'blocked']], ['start', '开始', ['claimed', 'blocked']], ['report-done', '标记完成', ['in_progress']],
    ['confirm-merge', '确认合并', ['awaiting_merge']], ['block', '标记阻塞', ['claimed', 'in_progress', 'reported_done', 'verifying', 'verify_failed', 'awaiting_merge']],
    ['cancel', '取消任务', ['draft', 'ready', 'claimed', 'in_progress', 'reported_done', 'blocked', 'merged']],
  ];
  const panelAgent = options.panelAgent ?? 'default';
  const ownerless = task.assigned_lane === null && task.agent === null;
  const ownerMatches = ownerless || (task.assigned_lane === panelAgent && task.agent === panelAgent);
  let ownerMismatch = false;
  const buttons = definitions.map(([action, label, states]) => {
    const needsOwner = action === 'start' || action === 'report-done' || action === 'block' || action === 'cancel';
    const mismatch = needsOwner && !ownerMatches;
    ownerMismatch ||= mismatch;
    const ownerReason = `需在车道 ${task.assigned_lane ?? '(main)'} 内由 ${task.agent ?? '未声明'} 执行`;
    const availableStates = task.status === 'blocked' ? states : states.filter((status) => status !== 'blocked');
    const reason = mismatch ? ownerReason : invalidLane ? '所属车道不可用，请重开面板' : !states.includes(task.status) ? `当前 ${task.status}；仅 ${availableStates.join(' / ')} 可用` : '';
    const form = action === 'confirm-merge' || action === 'block' || action === 'cancel' ? action : '';
    return actionButton(label, `/api/task/${encodeURIComponent(task.id)}/${action}`, `cowork task ${action} ${task.id}`, true, reason, form);
  }).join('');
  const choices = lanes.filter((lane) => lane.lane !== null && lane.error === undefined && /^[A-Za-z0-9._-]+$/.test(lane.lane)).map((lane) => `<option value="${escapeHtml(lane.lane!)}">${escapeHtml(lane.lane!)}</option>`).join('');
  const dispatch = `<div class="dispatch"><select aria-label="${escapeHtml(task.id)} 的车道"${task.status === 'ready' && choices !== '' ? '' : ' disabled'}>${choices}</select><button type="button" data-dispatch title="按队列顺序与依赖领取下一个任务"${task.status === 'ready' && choices !== '' ? '' : ' disabled'}>派给车道</button></div>`;
  const ownerCommand = ownerMismatch
    ? `<div class="sub mono"><code class="mono">cowork task start ${escapeHtml(task.id)}</code>${actionButton('', '', `cowork task start ${task.id}`, false)}</div>`
    : '';
  const retry = task.status === 'verify_failed' || (task.status === 'reported_done' && task.verification?.status === 'failed')
    ? actionButton('重跑验证', '', `cowork task done ${task.id}`, true)
    : '';
  return buttons + retry + dispatch + ownerCommand;
}

function verificationDetails(task: SnapshotTask): string {
  const verification = task.verification ?? null;
  if (verification === null) return '';
  const relevant = ['verifying', 'verify_failed', 'awaiting_merge', 'reported_done', 'blocked'].includes(task.status);
  if (!relevant) return '';
  const latest = verification.records.at(-1);
  const status = verification.status === 'running' ? '验证中' : verification.status === 'passed' ? '通过' : verification.status === 'stale' ? '已恢复' : '失败';
  const record = latest === undefined
    ? ''
    : `<div class="sub mono">${escapeHtml(latest.name)} · exit=${escapeHtml(String(latest.exit))} · ${escapeHtml(latest.duration_ms)}ms</div>`;
  const pidError = verification.pid_start_error
    ? `<div class="sub">PID 启动时间不可得: ${escapeHtml(verification.pid_start_error)}</div>`
    : '';
  const summary = verification.summary === '' ? '' : `<div class="sub">${escapeHtml(verification.summary)}</div>`;
  return `<div class="sub">验证 ${status} · config ${escapeHtml(verification.config_commit.slice(0, 7))}</div>${record}${pidError}${summary}`;
}

function taskContractCell(task: SnapshotTask, alerts: readonly ContractAlert[]): string {
  const matching = alerts.filter((alert) => alert.task === task.id || alert.peer_task === task.id);
  if (matching.length === 0) return '<span class="sub">—</span>';
  const details = matching.map((alert) => {
    const source = [alert.peer_task, alert.peer_lane, alert.handoff_path].filter((item): item is string => item !== null).join(' / ');
    return `<li>${escapeHtml(alert.kind)} · ${escapeHtml(alert.path)} · ${escapeHtml(source || '未说明来源')} · ${escapeHtml(alert.summary)}</li>`;
  }).join('');
  return `${badge(String(matching.length), 'warn')}<details><summary>来源</summary><ul class="diag">${details}</ul></details>`;
}

function renderTasks(tasks: readonly SnapshotTask[], lanes: readonly SnapshotLane[] = [], options: RenderOptions = {}, alerts: readonly ContractAlert[] = []): string {
  if (tasks.length === 0) {
    return '<p class="empty">还没有任务。cowork task add 创建 spec，cowork next 领取。</p>';
  }
  const rows = tasks
    .map((task) => {
      const lane = `<span class="mono">${escapeHtml(task.assigned_lane ?? '(main)')}</span>`;
      const agent = `<div class="sub mono">${escapeHtml(task.agent ?? '未声明')}</div>`;
      const blocked =
        task.blocked_reason === null
          ? ''
          : `<ul class="diag"><li>${escapeHtml(task.blocked_reason)}</li></ul>`;
      const deps =
        task.depends_on.length === 0
          ? '<span class="sub">—</span>'
          : task.depends_on.map((dep) => `<span class="mono">${escapeHtml(dep)}</span>`).join('<br>');
      const spec =
        task.spec_commit === null
          ? '<span class="sub">—</span>'
          : `<span class="mono">${escapeHtml(task.spec_commit.slice(0, 7))}</span>`;
      const unverified = task.status === 'reported_done' ? badge('未验证', 'warn') : '';
      return `<tr>
  <td><span class="mono">${escapeHtml(task.id)}</span><div>${escapeHtml(task.title)}</div>${blocked}</td>
  <td>${statusBadge(task.status)}${unverified}${verificationDetails(task)}</td>
  <td>${lane}${agent}</td>
  <td>${deps}</td>
  <td>${spec}</td>
  <td>${taskContractCell(task, alerts)}</td>
  <td class="actions">${taskActions(task, lanes, options)}</td>
</tr>`;
    })
    .join('');
  return `<table>
<thead><tr><th>任务</th><th>状态</th><th>车道 / agent</th><th>依赖</th><th>spec</th><th>契约</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** Structured read/write and handoff contract reminders. */
function renderAlerts(alerts: readonly ContractAlert[]): string {
  if (alerts.length === 0) return '';
  const rows = alerts
    .map(
      (alert) => `<tr>
  <td>${escapeHtml(alert.kind)}</td>
  <td><span class="mono">${escapeHtml(alert.task)}</span></td>
  <td><span class="mono">${escapeHtml(alert.path)}</span></td>
  <td>${escapeHtml([alert.peer_task, alert.peer_lane, alert.handoff_path].filter((item): item is string => item !== null).join(' / ') || '未说明')}</td>
  <td>${escapeHtml(alert.summary)}</td>
</tr>`,
    )
    .join('');
  return `<h3 class="sub">契约提醒</h3>
<table>
<thead><tr><th>类型</th><th>任务</th><th>路径</th><th>来源</th><th>说明</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderTaskDiagnostics(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return `<p class="err">有 ${lines.length} 条任务读取失败；这些任务没有进入上面的列表。</p>
<ul class="diag">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--ink:#1b1f24;--muted:#667085;--line:#e4e7ec;--chip:#f2f4f7;--accent:#2563eb;--ok:#067647;--ok-bg:#d1fadf;--warn:#b54708;--warn-bg:#fef0c7;--bad:#b42318;--bad-bg:#fee4e2;--mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#161a21;--ink:#e6e9ef;--muted:#9aa4b2;--line:#28303b;--chip:#1f252e;--accent:#7aa2ff;--ok:#6ce9a6;--ok-bg:#0f2e1d;--warn:#f5c26b;--warn-bg:#3a2a12;--bad:#f97066;--bad-bg:#3a1512}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;padding:28px 20px 56px}
.wrap{max-width:1180px;margin:0 auto;display:grid;gap:16px}
#board{display:grid;gap:16px;min-width:0;width:100%}
header{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
h1{font-size:20px;margin:0;font-weight:650}
h2{font-size:13px;margin:0;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.sub{color:var(--muted);font-size:12.5px}
.mono{font-family:var(--mono);font-size:12.5px}
.toolbar{display:flex;flex-wrap:wrap;gap:4px 18px;align-items:center}
input[type=search]{width:min(360px,100%);padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit}
input[type=search]:focus{outline:2px solid var(--accent);outline-offset:1px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px}
.card-head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--line)}
.card-body{padding:4px 16px 10px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 14px 10px 0;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
td:last-child,th:last-child{padding-right:0}
tbody tr:last-child td{border-bottom:none}
tr[hidden]{display:none}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--chip);color:var(--muted)}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.note{max-width:34ch;white-space:pre-wrap;overflow-wrap:anywhere}
.diag{margin:6px 0 0;padding:0;list-style:none;color:var(--warn);font-size:12px;max-width:42ch}
.diag li{overflow-wrap:anywhere}
.diag li::before{content:"! ";font-weight:700}
.empty{margin:0;padding:20px 0;color:var(--muted);font-size:13px}
.err{margin:10px 0;padding:9px 12px;border-radius:9px;background:var(--bad-bg);color:var(--bad);font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere}
footer{color:var(--muted);font-size:12px;padding:2px 2px 0}
button,input,textarea,select{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 9px}
button{cursor:pointer}button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button:disabled,select:disabled{opacity:.45;cursor:not-allowed}.actions{min-width:200px;max-width:330px}.actions button{font-size:12px;margin:0 4px 5px 0}.dispatch{display:flex;gap:5px;align-items:baseline}
.panel-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.panel-toolbar #refresh{margin-left:auto}dialog{width:min(520px,95vw);max-height:90vh;overflow:auto;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:22px}dialog::backdrop{background:#0007}
dialog h2{font-size:17px;color:var(--ink);margin-bottom:16px}dialog form,#form-fields{display:grid;gap:12px}dialog label{display:grid;gap:4px}textarea{min-height:65px;resize:vertical}.form-actions{display:flex;gap:8px;justify-content:flex-end}.primary{background:var(--accent);color:var(--panel)}
.result{padding:14px 16px}.result summary{cursor:pointer;font-weight:600}.result pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.6 var(--mono);max-height:340px;overflow:auto}.result[data-code="0"]{border-left:3px solid var(--ok)}.result[data-code="1"],.result[data-code="2"],.result[data-code="3"]{border-left:3px solid var(--warn)}
`;

const FILTER_SCRIPT = `<script>
(() => {
  const input = document.getElementById('filter');
  if (input === null) return;
  const apply = () => {
    const rows = Array.from(document.querySelectorAll('tbody tr:not(.err-row)'));
    const errors = Array.from(document.querySelectorAll('tbody tr.err-row'));
    const q = input.value.trim().toLowerCase();
    for (const row of rows) row.hidden = q !== '' && !row.textContent.toLowerCase().includes(q);
    for (const row of errors) row.hidden = q !== '';
  };
  // --watch 会按 meta refresh 重新载入页面；把过滤词放进 hash，刷新后还能接着看。
  const saved = new URLSearchParams(location.hash.slice(1)).get('filter');
  if (saved !== null) input.value = saved;
  apply();
  document.addEventListener('cowork:updated', apply);
  input.addEventListener('input', () => {
    apply();
    try {
      history.replaceState(null, '', input.value === '' ? '#' : '#filter=' + encodeURIComponent(input.value));
    } catch {
      // 个别浏览器在 file:// 下禁止改写 history；过滤本身不受影响。
    }
  });
})();
</script>`;

export interface RenderOptions {
  /** `ui --watch` 时传整秒间隔：页面用 meta refresh 自己重载，浏览器不需要人按 F5。 */
  refreshSeconds?: number | undefined;
  serve?: boolean;
  panelAgent?: string | undefined;
}

/** 三块表的唯一渲染函数；前台轮询也复用此函数及其纯函数依赖。 */
export function renderBoard(snap: Snapshot, options: RenderOptions = {}): string {
  const dirtyLanes = snap.lanes.filter((lane) => lane.dirty === true).length;
  const expiredClaims = snap.claims.filter((claim) => claim.expired).length;
  const blockedTasks = snap.tasks.filter((task) => task.status === 'blocked').length;
  const taskOptions = options.serve ? { ...options, panelAgent: snap.panel_agent ?? options.panelAgent ?? 'default' } : options;
  return `<section class="card">
  <div class="card-head"><h2>工作树</h2><span class="sub">${snap.lanes.length} 条${snap.lanes.length === 0 ? '' : `，${dirtyLanes} 条有未提交改动`}</span></div>
  <div class="card-body table-wrap">${renderLanes(snap.lanes, options)}</div>
</section>
<section class="card">
  <div class="card-head"><h2>占位</h2><span class="sub">${snap.claims.length} 个${expiredClaims > 0 ? `，其中 ${expiredClaims} 个已过期` : ''}</span></div>
  <div class="card-body table-wrap">${renderClaims(snap.claims)}</div>
</section>
<section class="card">
  <div class="card-head"><h2>任务与契约</h2><span class="sub">${snap.tasks.length} 个${blockedTasks > 0 ? `，${blockedTasks} 个被阻塞` : ''}${snap.task_diagnostics.length > 0 ? `，${snap.task_diagnostics.length} 条读取失败` : ''}</span></div>
  <div class="card-body table-wrap">${renderTasks(snap.tasks, snap.lanes, taskOptions, snap.contract_alerts)}${renderTaskDiagnostics(snap.task_diagnostics)}${renderAlerts(snap.contract_alerts)}</div>
</section>`;
}

const RESULT = `<details id="result" class="card result" aria-live="polite" hidden><summary></summary><p class="mono command"></p><pre class="stdout"></pre><pre class="stderr"></pre></details>`;

const COPY_SCRIPT = `<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const command = button.dataset.copy;
  const result = document.querySelector('#result');
  result.hidden = false; result.open = true;
  result.querySelector('.command').textContent = command;
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(command);
    else {
      const field = document.createElement('textarea'); field.value = command;
      document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      if (!copied) throw new Error('请选中下方命令手动复制');
    }
    result.querySelector('summary').textContent = '命令已复制';
  } catch (err) { result.querySelector('summary').textContent = String(err.message || err); }
});
</script>`;

const FORMS = `<div class="panel-toolbar">
<button type="button" data-open="lane">新建车道</button><button type="button" data-open="task">新建任务</button><button type="button" data-open="import">导入计划</button><span class="sub">派工按队列顺序与依赖领取</span><button type="button" id="refresh">刷新</button>
</div>
<dialog id="action-dialog"><h2 id="dialog-title"></h2><form id="action-form"><div id="form-fields"></div><div class="form-actions"><button type="button" id="close-dialog">返回</button><button type="submit" class="primary">执行</button></div></form></dialog>`;

function panelScript(): string {
  // 函数源码没有用户数据；共享服务器与浏览器渲染，避免双份表格模板漂移。
const helpers = [escapeHtml, localTime, badge, changesCell, handoffCell, diagnosticsCell, actionButton, renderLanes, renderClaims, statusBadge, taskActions, verificationDetails, taskContractCell, renderTasks, renderAlerts, renderTaskDiagnostics, renderBoard];
  const renderer = `const HTML_ESCAPES=${JSON.stringify(HTML_ESCAPES)};const STATUS_TONES=${JSON.stringify(STATUS_TONES)};` + helpers.map((fn) => `const ${fn.name}=${fn.toString()};`).join('\n');
  return `<script>
(() => {
${renderer}
  const token = new URLSearchParams(location.search).get('t');
  history.replaceState(null, '', location.pathname + location.hash);
  const board = document.querySelector('#board');
  const result = document.querySelector('#result');
  const dialog = document.querySelector('#action-dialog');
  const form = document.querySelector('#action-form');
  let target = null;
  let busy = false;
  let sampling = false;
  function output(command, value) {
    result.hidden = false; result.open = true;
    result.dataset.code = String(value.code);
    result.querySelector('summary').textContent = 'exit ' + value.code;
    result.querySelector('.command').textContent = command;
    result.querySelector('.stdout').textContent = value.stdout || '';
    result.querySelector('.stderr').textContent = value.stderr || '';
  }
  async function api(route, body) {
    const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cowork-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + text);
    return JSON.parse(text);
  }
  async function refresh(force) {
    if (sampling || (!force && (document.hidden || busy || board.contains(document.activeElement)))) return;
    sampling = true;
    try {
      const snap = await api('/api/snapshot');
      board.innerHTML = renderBoard(snap, { serve: true });
      document.querySelector('#as-of').textContent = '数据截至 ' + localTime(snap.generatedAt);
      document.querySelector('#trunk').textContent = 'trunk ' + (snap.repo.trunk || '未知');
      document.querySelector('#main-head').textContent = '主工作树 HEAD ' + (snap.repo.head || '?');
      document.dispatchEvent(new Event('cowork:updated'));
    } catch (err) { output('cowork snapshot --json', { code: 1, stderr: String(err.message || err) }); }
    finally { sampling = false; }
  }
  async function execute(route, body, command) {
    if (busy) return;
    busy = true;
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try { output(command, await api(route, body)); dialog.close(); }
    catch (err) { output(command, { code: 1, stderr: String(err.message || err) }); }
    finally { busy = false; submit.disabled = false; await refresh(true); }
  }
  const fields = {
    lane: [['name','车道名称',true],['base','基点（可选）',false]],
    task: [['title','任务标题',true],['touches','写入路径（每行一项）',true],['reads','读取路径（每行一项）',false],['depends_on','依赖任务 id（每行一项）',false],['done_when','验收命令（每行一项）',false]],
    import: [['path','计划文件路径（相对仓库根）',true]],
    'confirm-merge': [['commit','合并提交 SHA',true],['reason','人工确认依据',true]],
    block: [['reason','阻塞原因',true]], cancel: [['reason','取消原因（可选）',false]]
  };
  const titles = { lane:'新建车道',task:'新建任务',import:'导入计划','confirm-merge':'确认合并',block:'标记阻塞',cancel:'取消任务' };
  function open(kind, route, command) {
    target = { kind, route, command };
    document.querySelector('#dialog-title').textContent = titles[kind];
    document.querySelector('#form-fields').innerHTML = fields[kind].map(([name,label,required]) => '<label>' + label + '<' + (['touches','reads','depends_on','done_when'].includes(name) ? 'textarea' : 'input') + ' name="' + name + '" ' + (required ? 'required' : '') + (name === 'title' ? ' maxlength="120"' : '') + '>' + (['touches','reads','depends_on','done_when'].includes(name) ? '</textarea>' : '') + '</label>').join('') + (kind === 'import' ? '<label><span><input type="checkbox" name="dry_run"> 仅预览，不写入</span></label>' : '');
    dialog.showModal();
  }
  document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
  document.querySelector('#refresh').addEventListener('click', () => refresh(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(false); });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.hasAttribute('data-copy')) {
      const command = button.dataset.copy;
      result.hidden = false; result.open = true;
      result.querySelector('.command').textContent = command;
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(command);
        else {
          const field = document.createElement('textarea'); field.value = command;
          document.body.append(field); field.select();
          const copied = document.execCommand('copy'); field.remove();
          if (!copied) throw new Error('请选中下方命令手动复制');
        }
        result.querySelector('summary').textContent = '命令已复制';
      } catch (err) { result.querySelector('summary').textContent = String(err.message || err); }
      return;
    }
    if (button.disabled) return;
    if (button.dataset.open) {
      const kind = button.dataset.open;
      const route = kind === 'lane' ? '/api/lane/new' : kind === 'task' ? '/api/task/add' : '/api/import';
      open(kind, route, kind === 'lane' ? 'cowork lane new' : kind === 'task' ? 'cowork task add' : 'cowork task import');
    } else if (button.hasAttribute('data-dispatch')) {
      const lane = button.parentElement.querySelector('select').value;
      execute('/api/lane/' + encodeURIComponent(lane) + '/next', {}, 'cowork next --agent ' + lane + ' (cwd: .cowork/lanes/' + lane + ')');
    } else if (button.dataset.api) {
      if (button.dataset.form) open(button.dataset.form, button.dataset.api, button.dataset.command);
      else execute(button.dataset.api, button.dataset.api.startsWith('/api/brief?') ? undefined : {}, button.dataset.command);
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!target || busy || !form.reportValidity()) return;
    const data = new FormData(form); const body = {};
    for (const [key, value] of data) if (value !== '') body[key] = ['touches','reads','depends_on','done_when'].includes(key) ? value.split(/\\r?\\n/).map(s => s.trim()).filter(Boolean) : value;
    if (target.kind === 'import') body.dry_run = data.has('dry_run');
    let command = target.command;
    if (target.kind === 'lane') command += ' ' + JSON.stringify(body.name) + (body.base ? ' --base ' + JSON.stringify(body.base) : '');
    else if (target.kind === 'import') command += ' ' + JSON.stringify(body.path) + (body.dry_run ? ' --dry-run' : '');
    else if (target.kind === 'task') {
      command += ' --title ' + JSON.stringify(body.title);
      for (const [key, flag] of [['touches','touches'],['reads','reads'],['depends_on','depends'],['done_when','done-when']]) for (const value of body[key] || []) command += ' --' + flag + ' ' + JSON.stringify(value);
    } else command += (body.commit ? ' --commit ' + JSON.stringify(body.commit) + ' --manual' : '') + (body.reason ? ' --reason ' + JSON.stringify(body.reason) : '');
    execute(target.route, body, command);
  });
  setInterval(() => refresh(false), 2000);
})();
</script>`;
}

/** 静态单文件面板：自包含、无外部资源、不联网。 */
export function renderPanel(snap: Snapshot, options: RenderOptions = {}): string {
  const refreshSeconds = options.refreshSeconds;
  const repoName = path.basename(snap.repo.root) === '' ? snap.repo.root : path.basename(snap.repo.root);
  const filterable = snap.lanes.length + snap.claims.length + snap.tasks.length > 0;
  const head = snap.repo.head === null ? '?' : snap.repo.head;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds === undefined ? '' : `<meta http-equiv="refresh" content="${refreshSeconds}">`}
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'${options.serve ? "; connect-src 'self'" : ''}">
<meta name="referrer" content="no-referrer">
<title>cowork · ${escapeHtml(repoName)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>cowork · ${escapeHtml(repoName)}</h1>
  <span class="sub">${options.serve ? '派工面板 · 本机前台' : '只读面板'}${refreshSeconds === undefined ? '' : ` · 每 ${refreshSeconds} 秒自动刷新`}</span>
</header>
<div class="toolbar mono sub">
  <span title="仓库根">${escapeHtml(snap.repo.root)}</span>
  <span id="main-head" title="主工作树 HEAD，不一定是 trunk">主工作树 HEAD ${escapeHtml(head)}</span>
  <span id="trunk">trunk ${escapeHtml(snap.repo.trunk ?? '未知')}</span>
  <span id="as-of">${
    options.serve ? `数据截至 ${escapeHtml(localTime(snap.generatedAt))}` : refreshSeconds === undefined
      ? `数据截至 ${escapeHtml(localTime(snap.generatedAt))}，进程停止后不会继续更新。`
      : `数据截至 ${escapeHtml(localTime(snap.generatedAt))}，watch 每 ${refreshSeconds} 秒重写。`
  }</span>
</div>
${filterable ? '<input id="filter" type="search" placeholder="过滤车道 / 分支 / 占位 / 任务…" aria-label="过滤表格">' : ''}
${options.serve ? FORMS : ''}
<div id="board">${renderBoard(snap, options)}</div>
${RESULT}
<footer>数据只来自 cowork snapshot --json；${
    options.serve ? '每 2 秒采样，切到后台暂停；操作结果保留 CLI 原文，Ctrl+C 结束服务。' : refreshSeconds === undefined
      ? '本页由 cowork ui 生成，不读取 .git/cowork，也不写任何状态。重新运行 cowork ui 可刷新。'
      : `本页由 cowork ui --watch 每 ${refreshSeconds} 秒重写，浏览器按 meta refresh 自动重载；不读取 .git/cowork，也不写任何状态。Ctrl+C 停止 watch。`
  }</footer>
</div>
${filterable ? FILTER_SCRIPT : ''}
${options.serve ? panelScript() : COPY_SCRIPT}
</body>
</html>`;
}

/** 每个仓库一份固定路径，重复运行覆盖同一个文件，标签页刷新即可。 */
export function panelPath(info: RepoInfo): string {
  const digest = createHash('sha1')
    .update(info.commonDir.toLowerCase())
    .digest('hex')
    .slice(0, 12);
  return path.join(tmpdir(), 'cowork-ui', digest, 'index.html');
}

export interface WritePanelOptions {
  out?: string | undefined;
  refreshSeconds?: number | undefined;
}

/**
 * 原子写：先写同目录临时文件再 rename。--watch 每 2 秒重写一次，浏览器随时可能来读，
 * 不能让它读到写了一半的 HTML（与 store.ts 的 claim 写入同一套写法）。
 */
export function writePanel(
  info: RepoInfo,
  snap: Snapshot,
  options: WritePanelOptions = {},
): string {
  const file = options.out === undefined ? panelPath(info) : path.resolve(options.out);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, renderPanel(snap, { refreshSeconds: options.refreshSeconds }), 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理临时文件失败不掩盖真正的写入错误。
    }
    throw general(
      `无法写入面板文件 ${file}: ${err instanceof Error ? err.message : String(err)}`,
      '检查目标目录是否可写；Windows 上避开只读目录和过长的路径。',
    );
  }
  return file;
}

/** 默认 watch 间隔，与评审定下的「2 秒刷新、开着就行」一致。 */
export const DEFAULT_WATCH_INTERVAL_MS = 2000;

export interface WatchPanelOptions {
  out?: string | undefined;
  intervalMs: number;
  signal?: AbortSignal | undefined;
  /** 测试注入用；默认每次调用都做一次完整快照。 */
  source?: ((info: RepoInfo) => Promise<Snapshot>) | undefined;
  /** 每次「带自动刷新」的写入后调用；index 从 1 开始。 */
  onWrite?: ((file: string, snap: Snapshot, index: number) => void) | undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 前台看板循环：每隔 intervalMs 重新采样并原子重写同一个文件，页面靠 meta refresh 自己重载。
 * 不监听端口、不起后台进程；Ctrl+C 由调用方 abort。
 * 退出时再写一次不带 refresh 的版本，避免命令停了页面还在空转重载。
 */
export async function watchPanel(info: RepoInfo, options: WatchPanelOptions): Promise<string> {
  const takeSnapshot = options.source ?? snapshot;
  const refreshSeconds = Math.max(1, Math.round(options.intervalMs / 1000));
  // 用函数读取，避免 TS 把第一次检查后的类型收窄成 false|undefined。
  const aborted = (): boolean => options.signal?.aborted === true;
  let index = 0;
  let lastFile: string | null = null;
  for (;;) {
    const snap = await takeSnapshot(info);
    const file = writePanel(info, snap, { out: options.out, refreshSeconds });
    lastFile = file;
    index += 1;
    options.onWrite?.(file, snap, index);
    if (aborted()) break;
    await sleep(options.intervalMs, options.signal);
    if (aborted()) break;
  }
  // 收尾写失败（磁盘满、目录被删）只警告，不改变已经确定的退出状态。
  try {
    const final = await takeSnapshot(info);
    return writePanel(info, final, { out: options.out });
  } catch (err) {
    console.warn(
      `cowork: 退出前写入最终面板失败（页面可能仍保留自动刷新）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return lastFile ?? (options.out === undefined ? panelPath(info) : path.resolve(options.out));
  }
}

/** 只在用户显式 --open 时调用；失败不影响面板本身。 */
export async function openPanel(file: string): Promise<void> {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', file];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [file];
  } else {
    command = 'xdg-open';
    args = [file];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
