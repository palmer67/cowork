import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { general } from './errors.ts';
import type { RepoInfo } from './git.ts';
import { snapshot } from './snapshot.ts';
import type {
  ContractAlert,
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

function renderLanes(lanes: readonly SnapshotLane[]): string {
  if (lanes.length === 0) {
    return '<p class="empty">没有可读的工作树。git worktree list 应至少包含主工作树。</p>';
  }
  const rows = lanes
    .map((lane) => {
      const label = lane.lane === null ? '(main)' : lane.lane;
      const err =
        lane.error === undefined
          ? ''
          : `<tr class="err-row"><td colspan="6"><p class="err">${escapeHtml(lane.error)}</p></td></tr>`;
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
</tr>${err}`;
    })
    .join('');
  return `<table>
<thead><tr><th>车道</th><th>分支</th><th>HEAD</th><th>未提交</th><th>最近交接</th><th>采样时间</th></tr></thead>
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
  reported_done: 'warn',
  in_progress: 'warn',
  ready: 'warn',
};

function statusBadge(status: string): string {
  return badge(status, STATUS_TONES[status]);
}

function renderTasks(tasks: readonly SnapshotTask[]): string {
  if (tasks.length === 0) {
    return '<p class="empty">还没有任务。cowork task add 创建 spec，cowork next 领取。</p>';
  }
  const rows = tasks
    .map((task) => {
      const lane =
        task.assigned_lane === null
          ? '<span class="sub">(未领取)</span>'
          : `<span class="mono">${escapeHtml(task.assigned_lane)}</span>`;
      const agent = task.agent === null ? '' : `<div class="sub mono">${escapeHtml(task.agent)}</div>`;
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
      return `<tr>
  <td><span class="mono">${escapeHtml(task.id)}</span><div>${escapeHtml(task.title)}</div>${blocked}</td>
  <td>${statusBadge(task.status)}</td>
  <td>${lane}${agent}</td>
  <td>${deps}</td>
  <td>${spec}</td>
</tr>`;
    })
    .join('');
  return `<table>
<thead><tr><th>任务</th><th>状态</th><th>车道 / agent</th><th>依赖</th><th>spec</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** §8 唯一的契约提醒：本任务 reads 与另一活跃任务 touches 重叠。 */
function renderAlerts(alerts: readonly ContractAlert[]): string {
  if (alerts.length === 0) return '';
  const rows = alerts
    .map(
      (alert) => `<tr>
  <td><span class="mono">${escapeHtml(alert.task)}</span></td>
  <td><span class="mono">${escapeHtml(alert.path)}</span></td>
  <td><span class="mono">${escapeHtml(alert.peer_task)}</span></td>
</tr>`,
    )
    .join('');
  return `<h3 class="sub">契约提醒（reads ↔ 其他任务的 touches）</h3>
<table>
<thead><tr><th>读方任务</th><th>路径</th><th>写方任务</th></tr></thead>
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
`;

const FILTER_SCRIPT = `<script>
(() => {
  const input = document.getElementById('filter');
  if (input === null) return;
  const rows = Array.from(document.querySelectorAll('tbody tr:not(.err-row)'));
  const errors = Array.from(document.querySelectorAll('tbody tr.err-row'));
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    for (const row of rows) row.hidden = q !== '' && !row.textContent.toLowerCase().includes(q);
    for (const row of errors) row.hidden = q !== '';
  };
  // --watch 会按 meta refresh 重新载入页面；把过滤词放进 hash，刷新后还能接着看。
  const saved = new URLSearchParams(location.hash.slice(1)).get('filter');
  if (saved !== null) input.value = saved;
  apply();
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
}

/** 静态单文件面板：自包含、无外部资源、不联网。 */
export function renderPanel(snap: Snapshot, options: RenderOptions = {}): string {
  const refreshSeconds = options.refreshSeconds;
  const repoName = path.basename(snap.repo.root) === '' ? snap.repo.root : path.basename(snap.repo.root);
  const dirtyLanes = snap.lanes.filter((lane) => lane.dirty === true).length;
  const expiredClaims = snap.claims.filter((claim) => claim.expired).length;
  const blockedTasks = snap.tasks.filter((task) => task.status === 'blocked').length;
  const filterable = snap.lanes.length + snap.claims.length + snap.tasks.length > 0;
  const head = snap.repo.head === null ? '?' : snap.repo.head;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds === undefined ? '' : `<meta http-equiv="refresh" content="${refreshSeconds}">`}
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>cowork · ${escapeHtml(repoName)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>cowork · ${escapeHtml(repoName)}</h1>
  <span class="sub">只读面板${refreshSeconds === undefined ? '' : ` · 每 ${refreshSeconds} 秒自动刷新`}</span>
</header>
<div class="toolbar mono sub">
  <span title="仓库根">${escapeHtml(snap.repo.root)}</span>
  <span title="主工作树 HEAD，不一定是 trunk">主工作树 HEAD ${escapeHtml(head)}</span>
  <span>${
    refreshSeconds === undefined
      ? `数据截至 ${escapeHtml(localTime(snap.generatedAt))}，进程停止后不会继续更新。`
      : `数据截至 ${escapeHtml(localTime(snap.generatedAt))}，watch 每 ${refreshSeconds} 秒重写。`
  }</span>
</div>
${filterable ? '<input id="filter" type="search" placeholder="过滤车道 / 分支 / 占位 / 任务…" aria-label="过滤表格">' : ''}
<section class="card">
  <div class="card-head">
    <h2>工作树</h2>
    <span class="sub">${snap.lanes.length} 条${snap.lanes.length === 0 ? '' : `，${dirtyLanes} 条有未提交改动`}</span>
  </div>
  <div class="card-body table-wrap">
    ${renderLanes(snap.lanes)}
  </div>
</section>
<section class="card">
  <div class="card-head">
    <h2>占位</h2>
    <span class="sub">${snap.claims.length} 个${expiredClaims > 0 ? `，其中 ${expiredClaims} 个已过期` : ''}</span>
  </div>
  <div class="card-body table-wrap">
    ${renderClaims(snap.claims)}
  </div>
</section>
<section class="card">
  <div class="card-head">
    <h2>任务与契约</h2>
    <span class="sub">${snap.tasks.length} 个${blockedTasks > 0 ? `，${blockedTasks} 个被阻塞` : ''}${
      snap.task_diagnostics.length > 0 ? `，${snap.task_diagnostics.length} 条读取失败` : ''
    }</span>
  </div>
  <div class="card-body table-wrap">
    ${renderTasks(snap.tasks)}
    ${renderTaskDiagnostics(snap.task_diagnostics)}
    ${renderAlerts(snap.contract_alerts)}
  </div>
</section>
<footer>数据只来自 cowork snapshot --json；${
    refreshSeconds === undefined
      ? '本页由 cowork ui 生成，不读取 .git/cowork，也不写任何状态。重新运行 cowork ui 可刷新。'
      : `本页由 cowork ui --watch 每 ${refreshSeconds} 秒重写，浏览器按 meta refresh 自动重载；不读取 .git/cowork，也不写任何状态。Ctrl+C 停止 watch。`
  }</footer>
</div>
${filterable ? FILTER_SCRIPT : ''}
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
