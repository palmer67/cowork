#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claim, doctorFix, expiresAt, release, status } from './claims.ts';
import { CoworkError, EXIT, general, pathError } from './errors.ts';
import { currentBranch, headCommit, repoInfo, type RepoInfo } from './git.ts';
import { snapshot, type Snapshot } from './snapshot.ts';
import { stateRoot, type ClaimRecord } from './store.ts';
import {
  addTask,
  blockTask,
  brief,
  cancelTask,
  confirmMerge,
  defaultAgent,
  laneNew,
  listTasks,
  readyTask,
  reportDone,
  showTask,
  startTask,
  type TaskView,
} from './taskops.ts';
import { next } from './tasknext.ts';
import { doctorTasks } from './taskdoctor.ts';
import { readTrunkCatalog } from './tasks.ts';
import { DEFAULT_WATCH_INTERVAL_MS, openPanel, watchPanel, writePanel } from './ui.ts';
import { importPlan } from './planimport.ts';
import { createPanelServer, parsePort } from './uiserver.ts';
import { taskDone } from './taskverify.ts';
import { previewMerge, renderMergePreview } from './merge.ts';
import { dashboard, renderDashboard } from './dashboard.ts';

/** 命令名先于 needRepo() 校验：未知命令在任何目录下都是 1，而不是「不在仓库里」的 3。 */
const KNOWN_COMMANDS = new Set([
  'init',
  'claim',
  'release',
  'status',
  'snapshot',
  'ui',
  'task',
  'next',
  'lane',
  'brief',
  'doctor',
  'merge',
]);

const USAGE = `cowork — 多 agent 同仓协作纪律层

用法:
  cowork init                     初始化仓库内的 .cowork/ 与配置
  cowork claim <路径>...          占位（精确文件或目录前缀，目录可写 dir/**）
  cowork release [<路径>...]      释放占位（省略路径则释放本工作树全部）
  cowork status [--json]          只读仪表盘：车道、占位、任务、提示（最多 40 行）
  cowork merge --dry-run <lane> [--base <ref>] [--json]
                                  只读合并预演（不修改工作树或引用）
  cowork snapshot [--json]        只读快照：车道、未提交改动、占位与任务
  cowork task add --title <文本> [--touches <路径>]... [--reads <路径>]...
               [--depends <id>]... [--done-when <命令>]...
                                  创建 draft 任务规格（不接受 --status）
  cowork task ls [--status <状态>] [--json]
  cowork task show <id> [--json]
  cowork task ready <id>          draft → ready（要求 spec 已在 trunk 可达）
  cowork next [--agent <名>] [--json]
                                  领取一个 ready 任务（FIFO；崩溃事务可恢复）
  cowork task start|report-done <id>
  cowork task done <id>           执行 trunk 配置的自动验证
  cowork task confirm-merge <id> --commit <sha> [--manual --reason <文本>]
  cowork task block <id> --reason <文本>
  cowork task cancel <id> [--reason <文本>]
  cowork task import <plan.json> [--dry-run] [--ready]
  cowork brief [--agent <名>]    开工摘要（只读）
  cowork lane new <名> [--base <ref>]
                                  创建车道（git worktree，不持锁）
  cowork ui [--out <路径>] [--open]
  cowork ui --serve [--port <端口>] [--open]
  cowork ui --watch [--interval <秒>]
                                  生成只读看板（静态 HTML，不监听端口）；
                                  --watch 前台重写，Ctrl+C 退出，默认 2 秒
  cowork doctor [--fix]           检查状态目录与残留占位
  cowork version                  版本

退出码: 0 成功 / 1 一般错误 / 2 被占用或冲突 / 3 环境不满足`;

interface Args {
  command: string;
  rest: string[];
  flags: Set<string>;
  /** 值型 flag 可以有多个（--touches 可重复）；取最后一个用 value()，取全部用 values()。 */
  values: Map<string, string[]>;
}

const VALUE_FLAGS = new Set([
  'note',
  'out',
  'interval',
  'title',
  'touches',
  'reads',
  'depends',
  'done-when',
  'status',
  'agent',
  'reason',
  'commit',
  'base',
  'port',
]);

function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...tail] = argv;
  const rest: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const push = (name: string, value: string): void => {
    const list = values.get(name);
    if (list === undefined) values.set(name, [value]);
    else list.push(value);
  };
  for (let i = 0; i < tail.length; i += 1) {
    const item = tail[i] as string;
    if (!item.startsWith('--')) {
      rest.push(item);
      continue;
    }
    const body = item.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      push(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = tail[i + 1];
    if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      push(body, next);
      i += 1;
      continue;
    }
    flags.add(body);
  }
  return { command, rest, flags, values };
}

function value(args: Args, name: string): string | null {
  const list = args.values.get(name);
  if (list === undefined || list.length === 0) return null;
  return list[list.length - 1] as string;
}

function values(args: Args, name: string): string[] {
  return args.values.get(name) ?? [];
}

function needRepo(): RepoInfo {
  return repoInfo(process.cwd());
}

function runInit(info: RepoInfo): number {
  const coworkDir = path.join(info.mainRoot, '.cowork');
  mkdirSync(path.join(coworkDir, 'notes'), { recursive: true });
  mkdirSync(path.join(coworkDir, 'lanes'), { recursive: true });
  const configPath = path.join(coworkDir, 'config.json');
  if (!existsSync(configPath)) {
    const trunk = currentBranch(info.mainRoot) ?? 'main';
    writeFileSync(
      configPath,
      `${JSON.stringify({ schemaVersion: 1, trunk }, null, 2)}\n`,
      'utf8',
    );
    console.log(`已创建 ${path.relative(process.cwd(), configPath)}（trunk=${trunk}）`);
  } else {
    console.log('配置已存在，未改动');
  }

  const gitignore = path.join(info.mainRoot, '.gitignore');
  const needed = ['.cowork/lanes/'];
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = needed.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (missing.length > 0) {
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignore, `${current}${prefix}${missing.join('\n')}\n`, 'utf8');
    console.log(`已写入 .gitignore: ${missing.join(', ')}`);
  }

  console.log(`live 状态目录: ${stateRoot(info)}（不进入 Git）`);
  return EXIT.OK;
}

async function runClaim(
  info: RepoInfo,
  inputs: readonly string[],
  args: Args,
): Promise<number> {
  const note = value(args, 'note') ?? undefined;
  const result = await claim(info, inputs, { note });
  for (const rec of result.claimed) console.log(`已占位 ${rec.display}`);
  for (const rec of result.refreshed) console.log(`已续期 ${rec.display}`);
  for (const rec of result.pruned) console.log(`已清理失效占位 ${rec.display}（pid ${rec.pid} 已退出）`);
  return EXIT.OK;
}

async function runRelease(info: RepoInfo, inputs: readonly string[], force: boolean): Promise<number> {
  const result = await release(info, inputs, { force });
  if (result.released.length === 0) {
    console.log('没有可释放的占位');
    return EXIT.OK;
  }
  for (const rec of result.released) console.log(`已释放 ${rec.display}`);
  return EXIT.OK;
}

function describeAgent(rec: ClaimRecord): string {
  const who = rec.agentId === 'default' ? '' : ` agent=${rec.agentId}`;
  return `pid ${rec.pid}@${rec.host}${who}`;
}

async function runStatus(info: RepoInfo, json: boolean): Promise<number> {
  const report = await dashboard(info);
  console.log(json ? JSON.stringify(report, null, 2) : renderDashboard(report));
  return EXIT.OK;
}

function stamp(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printSnapshot(snap: Snapshot): void {
  console.log(`仓库: ${snap.repo.root}`);
  console.log(`HEAD: ${snap.repo.head ?? '?'}`);
  console.log(`生成于: ${stamp(snap.generatedAt)}`);
  console.log('');
  if (snap.lanes.length === 0) {
    console.log('工作树: 没有可读的工作树（git worktree list 为空）。');
  } else {
    const laneWidth = Math.min(Math.max(...snap.lanes.map((l) => (l.lane ?? '(main)').length), 4), 24);
    const branchWidth = Math.min(
      Math.max(...snap.lanes.map((l) => (l.branch ?? 'detached').length), 6),
      28,
    );
    console.log(`工作树 (${snap.lanes.length}):`);
    for (const lane of snap.lanes) {
      const changes =
        lane.dirty === null
          ? '未知'
          : lane.dirty
            ? `${lane.changed_file_count ?? 0} 个文件`
            : '干净';
      const handoff =
        lane.last_handoff.id === null
          ? '—'
          : `${lane.last_handoff.id}（${stamp(lane.last_handoff.created_at)}）`;
      console.log(
        `  ${(lane.lane ?? '(main)').padEnd(laneWidth)}  ${(lane.branch ?? 'detached').padEnd(branchWidth)}  ${lane.head ?? '?'}  ${changes.padEnd(8)}  最近交接 ${handoff}`,
      );
      if (lane.error !== undefined) console.log(`  ↳ ${lane.error}`);
    }
  }
  console.log('');
  const expired = snap.claims.filter((claim) => claim.expired).length;
  console.log(`占位: ${snap.claims.length} 个${expired > 0 ? `（其中 ${expired} 个已过期）` : ''}`);
  for (const claim of snap.claims) {
    const lane = claim.lane === null ? '(主工作树)' : claim.lane;
    const expires = claim.expired ? '已过期' : stamp(claim.expiresAt);
    const note = claim.note === null ? '' : `  备注: ${claim.note}`;
    console.log(
      `  ${claim.path}  ${lane}  ${claim.agent} pid ${claim.pid}@${claim.host}  过期 ${expires}${note}`,
    );
  }
  console.log('');
  console.log('运行 cowork ui 生成只读看板。');
}

async function runSnapshot(info: RepoInfo, json: boolean): Promise<number> {
  const snap = await snapshot(info);
  if (json) {
    console.log(JSON.stringify(snap, null, 2));
    return EXIT.OK;
  }
  printSnapshot(snap);
  return EXIT.OK;
}

function parseInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WATCH_INTERVAL_MS / 1000;
  if (!/^\d+$/.test(raw)) {
    throw general(`--interval 需要整数秒: ${raw}`, '例如: cowork ui --watch --interval 2');
  }
  const seconds = Number(raw);
  if (seconds < 1 || seconds > 3600) {
    throw general(`--interval 超出范围: ${seconds}`, '取值 1..3600 秒；meta refresh 只支持整秒。');
  }
  return seconds;
}

async function openQuietly(file: string): Promise<void> {
  try {
    await openPanel(file);
  } catch (err) {
    console.warn(`cowork: 无法自动打开浏览器: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('  → 面板已生成，直接打开上面的路径即可。');
  }
}

async function runUi(info: RepoInfo, args: Args): Promise<number> {
  const out = value(args, 'out') ?? undefined;
  const watching = args.flags.has('watch');
  if (args.flags.has('serve')) {
    if (out !== undefined || watching) throw general('--serve 不能和 --out / --watch 一起使用', '用法: cowork ui --serve [--port <端口>] [--open]');
    if (value(args, 'interval') !== null) throw general('--interval 只能和 --watch 一起用');
    if (args.flags.has('port')) throw new CoworkError(EXIT.ENV, '--port 缺少端口；请用 --port 7788 或其它空闲端口。');
    let port: number;
    try { port = parsePort(value(args, 'port') ?? undefined); }
    catch (err) { throw new CoworkError(EXIT.ENV, err instanceof Error ? err.message : String(err), '例如: cowork ui --serve --port 7788'); }
    const cliPath = process.argv[1];
    if (cliPath === undefined) throw general('无法确定 cowork CLI 入口', '从 node <cli> 启动后重试。');
    const panel = createPanelServer(info, { port, cliPath: path.resolve(cliPath) });
    const url = await panel.listen().catch((err: unknown) => {
      throw new CoworkError(EXIT.ENV, err instanceof Error ? err.message : String(err), '确认端口空闲，或用 --port 指定 1..65535 内的本机端口。');
    });
    console.log(`面板已启动: ${url}`);
    if (args.flags.has('open')) await openQuietly(url);
    const stop = (): void => { void panel.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    await new Promise<void>((resolve) => panel.server.once('close', resolve));
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    return EXIT.OK;
  }
  if (value(args, 'port') !== null) throw general('--port 只能和 --serve 一起用', '用法: cowork ui --serve [--port <端口>]');
  if (!watching && value(args, 'interval') !== null) {
    throw general('--interval 只能和 --watch 一起用', '用法: cowork ui --watch [--interval <秒>]');
  }

  if (!watching) {
    const snap = await snapshot(info);
    const file = writePanel(info, snap, { out });
    console.log(file);
    console.log('面板已生成；重新运行 cowork ui 可刷新，浏览器刷新页面即可看到新数据。');
    console.log('想开着自动刷新: cowork ui --watch（Ctrl+C 退出）。');
    if (args.flags.has('open')) await openQuietly(file);
    return EXIT.OK;
  }

  const seconds = parseInterval(value(args, 'interval') ?? undefined);
  const controller = new AbortController();
  let stopping = false;
  const fatal: Error[] = [];
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('正在停止 watch…');
    controller.abort();
  };
  // 未捕获异常 / 未处理的 rejection 也先让 watch 写完不带 refresh 的最终版本再退。
  const onFatal = (err: unknown): void => {
    if (stopping) return;
    stopping = true;
    fatal.push(err instanceof Error ? err : new Error(String(err)));
    console.log('');
    console.log('watch 异常中断，正在写入最终面板…');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  try {
    const file = await watchPanel(info, {
      out,
      intervalMs: seconds * 1000,
      signal: controller.signal,
      onWrite: (panelFile, _snap, index) => {
        if (index !== 1) return;
        console.log(panelFile);
        console.log(`watch 模式：每 ${seconds} 秒重写一次，Ctrl+C 退出。`);
        if (args.flags.has('open')) void openQuietly(panelFile);
      },
    });
    const first = fatal[0];
    if (first !== undefined) throw first;
    console.log(`已停止。面板: ${file}`);
    return EXIT.OK;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  }
}

async function runDoctor(info: RepoInfo, fix: boolean): Promise<number> {
  console.log(`主仓库: ${info.mainRoot}`);
  console.log(`共享 git 目录: ${info.commonDir}`);
  console.log(`live 状态: ${stateRoot(info)}`);
  let bad = false;
  const state = stateRoot(info);
  if (!existsSync(state)) {
    console.log('状态目录尚未创建（还没运行过任何占位或任务命令）。');
  } else if (!fix) {
    const report = await status(info);
    if (report.expired.length === 0) {
      console.log('未发现过期占位。');
    } else {
      bad = true;
      console.log(`发现 ${report.expired.length} 个已过期占位:`);
      for (const rec of report.expired) console.log(`  ${rec.display}  ${rec.createdAt}  ${describeAgent(rec)}`);
      console.log('运行 cowork doctor --fix 清理。');
    }
  } else {
    const report = await doctorFix(info);
    for (const rec of report.pruned) console.log(`已清理 ${rec.display}（${describeAgent(rec)}，已过期）`);
    for (const item of report.quarantined) {
      const where = item.trash === null ? '隔离失败，原文件仍在' : `已隔离到 ${item.trash}`;
      console.log(`已隔离损坏状态文件 ${item.path}：${where}`);
      console.log(`  → ${item.reason}`);
    }
    if (report.pruned.length === 0 && report.quarantined.length === 0) {
      console.log('未发现过期占位或损坏状态。');
    }
  }

  const tasks = await doctorTasks(info, fix);
  for (const line of tasks.fixed) console.log(line);
  for (const line of tasks.notices) console.log(`提示: ${line}`);
  if (tasks.problems.length === 0) {
    console.log('任务层未发现问题。');
  } else {
    bad = true;
    console.log(`任务层发现 ${tasks.problems.length} 个问题:`);
    for (const line of tasks.problems) console.log(`  ${line}`);
    console.log('能自动修的先运行 cowork doctor --fix；spec 问题需要改文件后重新提交。');
  }
  return bad ? EXIT.GENERAL : EXIT.OK;
}

function printTaskRow(view: TaskView): void {
  const lane = view.assigned_lane ?? '(未领取)';
  const agent = view.agent === null ? '' : ` agent=${view.agent}`;
  console.log(`${view.id}  ${view.status.padEnd(13)}  ${lane.padEnd(14)} ${view.title}${agent}`);
}

function printTaskDetail(view: TaskView, history: readonly string[]): void {
  console.log(`${view.id}  ${view.title}`);
  console.log(`  状态: ${view.status}`);
  if (view.blocked_reason !== null) console.log(`  阻塞原因: ${view.blocked_reason}`);
  console.log(`  touches: ${view.touches.join(', ') || '(空)'}`);
  console.log(`  reads: ${view.reads.join(', ') || '(空)'}`);
  console.log(`  depends_on: ${view.depends_on.join(', ') || '(空)'}`);
  console.log(`  done_when: ${view.done_when.join('; ') || '(空)'}`);
  console.log(`  车道: ${view.assigned_lane ?? '(未领取)'}  agent: ${view.agent ?? '(无)'}`);
  console.log(`  spec_commit: ${view.spec_commit ?? '(无)'}`);
  console.log(`  更新时间: ${stamp(view.updated_at)}`);
  if (view.spec_path !== null) console.log(`  spec: ${view.spec_path}`);
  if (history.length > 0) {
    console.log('  最近历史:');
    for (const line of history) console.log(`    ${line}`);
  }
}

async function runTask(info: RepoInfo, args: Args, rest: readonly string[]): Promise<number> {
  const sub = rest[0] ?? '';
  const id = rest[1] ?? '';
  const needId = (): string => {
    if (id === '') throw general('需要任务 id', '例如: cowork task show t-3f9a1c');
    return id;
  };
  const agent = defaultAgent(value(args, 'agent'));

  switch (sub) {
    case 'add': {
      const title = value(args, 'title');
      if (title === null || title.trim() === '') {
        throw general('task add 需要 --title <文本>', '例如: cowork task add --title "给登录页加验证码" --touches src/auth/**');
      }
      const touches = values(args, 'touches');
      if (touches.length === 0) {
        throw general('touches 不能为空', '至少一个 --touches <路径>；touches 决定领取时的文件占位。');
      }
      const spec = await addTask(info, {
        title,
        touches,
        reads: values(args, 'reads'),
        depends_on: values(args, 'depends'),
        done_when: values(args, 'done-when'),
      });
      console.log(`已创建 ${spec.id}（draft）`);
      console.log(`  ${spec.path}`);
      console.log(`下一步: 把 spec 提交到 trunk 后运行 cowork task ready ${spec.id}。`);
      return EXIT.OK;
    }
    case 'ls': {
      const filter = value(args, 'status');
      const list = await listTasks(info, filter);
      if (args.flags.has('json')) {
        console.log(JSON.stringify(list, null, 2));
        return EXIT.OK;
      }
      if (list.views.length === 0) console.log('没有任务。用 cowork task add 创建 spec。');
      for (const view of list.views) printTaskRow(view);
      for (const diag of list.diagnostics) console.log(`! ${diag.file}: ${diag.error}`);
      return EXIT.OK;
    }
    case 'show': {
      const result = await showTask(info, needId());
      if (args.flags.has('json')) {
        console.log(JSON.stringify(result, null, 2));
        return EXIT.OK;
      }
      const history = (result.live?.history ?? [])
        .slice(-5)
        .map((entry) => `${stamp(entry.at)}  ${entry.from ?? '—'} → ${entry.to}${entry.agent === null ? '' : `  agent=${entry.agent}`}${entry.note === null ? '' : `  ${entry.note}`}`);
      printTaskDetail(result.view, history);
      return EXIT.OK;
    }
    case 'ready': {
      const live = await readyTask(info, needId());
      console.log(`${live.id} → ready（spec_commit ${live.spec_commit ?? '?'}）`);
      console.log(`下一步: cowork next 领取，或先 cowork task ls 查看队列。`);
      return EXIT.OK;
    }
    case 'start': {
      const live = await startTask(info, needId(), agent);
      console.log(`${live.id} → in_progress（agent=${agent}）`);
      return EXIT.OK;
    }
    case 'report-done': {
      const live = await reportDone(info, needId(), agent);
      console.log(`${live.id} → reported_done（agent=${agent}）`);
      console.log(`尚未验证；运行 cowork task done ${live.id}。`);
      return EXIT.OK;
    }
    case 'done': {
      const result = await taskDone(info, needId(), agent);
      console.log(`${result.live.id} → ${result.live.status}`);
      console.log(result.message);
      if (result.output !== '') {
        console.log('验证输出:');
        process.stdout.write(result.output);
        if (!result.output.endsWith('\n')) process.stdout.write('\n');
      }
      return result.passed ? EXIT.OK : EXIT.GENERAL;
    }
    case 'confirm-merge': {
      const commit = value(args, 'commit') ?? '';
      const reason = value(args, 'reason');
      const result = await confirmMerge(info, needId(), {
        commit,
        manual: args.flags.has('manual'),
        reason,
      });
      console.log(`${result.live.id} → merged（${commit.slice(0, 7)}）`);
      for (const display of result.released) console.log(`  已释放占位 ${display}`);
      return EXIT.OK;
    }
    case 'block': {
      const reason = value(args, 'reason') ?? '';
      const live = await blockTask(info, needId(), agent, reason);
      console.log(`${live.id} → blocked（${reason}）`);
      return EXIT.OK;
    }
    case 'cancel': {
      const reason = value(args, 'reason');
      const result = await cancelTask(info, needId(), agent, reason);
      console.log(`${result.live.id} → cancelled`);
      for (const display of result.released) console.log(`  已释放占位 ${display}`);
      return EXIT.OK;
    }
    case 'import': {
      const file = rest[1] ?? '';
      if (file === '') throw general('task import 需要 plan.json 路径', '例如: cowork task import plan.json');
      const result = await importPlan(info, path.resolve(process.cwd(), file), { dryRun: args.flags.has('dry-run') });
      console.log(`${result.dryRun ? '计划将导入' : '导入'} ${result.tasks.length} 个任务（draft）:`);
      for (const task of result.tasks) console.log(`  ${task.key.padEnd(18)} → ${task.id}`);
      console.log('依赖:');
      for (const task of result.tasks) for (const dep of task.depends_on) console.log(`  ${task.id} depends_on ${dep}`);
      if (result.dryRun) {
        console.log('将要写入:');
        for (const task of result.tasks) console.log(`  ${path.relative(info.mainRoot, task.path)}`);
        console.log('（dry-run：未写入文件）');
      }
      else console.log('下一步: git add .cowork/tasks && git commit -m "task: …"，然后 cowork task ready <id>');
      if (args.flags.has('ready')) for (const task of result.tasks) console.log(`  cowork task ready ${task.id}`);
      return EXIT.OK;
    }
    default:
      throw general(
        `未知 task 子命令: ${sub === '' ? '(空)' : sub}`,
        '可用: add / ls / show / ready / start / report-done / done / confirm-merge / block / cancel。',
      );
  }
}

async function runNext(info: RepoInfo, args: Args): Promise<number> {
  const agent = defaultAgent(value(args, 'agent'));
  const result = await next(info, { agent });
  if (args.flags.has('json')) {
    console.log(JSON.stringify(result, null, 2));
    return EXIT.OK;
  }
  if (result.recovery.recovered.length > 0) {
    console.log(`已回滚未完成事务: ${result.recovery.recovered.join(', ')}`);
  }
  console.log(`已领取 ${result.task.id}  ${result.task.title}`);
  console.log(`  touches: ${result.task.touches.join(', ') || '(空)'}`);
  console.log(`  depends_on: ${result.task.depends_on.join(', ') || '(空)'}`);
  console.log(`  done_when: ${result.task.done_when.join('; ') || '(空)'}`);
  console.log(`  lane: ${result.live.lane ?? '(main)'}  agent: ${agent}`);
  console.log(`  spec_commit: ${result.specCommit}`);
  if (result.contract_alerts.length > 0) {
    console.log('契约提醒:');
    for (const alert of result.contract_alerts) {
      const source = [alert.peer_task, alert.peer_lane, alert.handoff_path].filter((item): item is string => item !== null).join(' / ');
      console.log(`  ${alert.kind}: ${alert.path} ← ${source || alert.summary}${source ? `（${alert.summary}）` : ''}`);
    }
  }
  console.log('下一步: cowork task start ' + result.task.id);
  return EXIT.OK;
}

async function runBrief(info: RepoInfo, args: Args): Promise<number> {
  const catalog = readTrunkCatalog(info);
  const text = await brief(info, { agent: defaultAgent(value(args, 'agent')), catalog });
  console.log(text);
  return EXIT.OK;
}

async function runLane(info: RepoInfo, args: Args, rest: readonly string[]): Promise<number> {
  if (rest[0] !== 'new') {
    throw general(`未知 lane 子命令: ${rest[0] ?? '(空)'}`, '用法: cowork lane new <名> [--base <ref>]');
  }
  if (args.flags.has('task')) {
    throw general('lane new 不接受 --task', '任务用 cowork task add/ready 管理；lane 只建工作树。');
  }
  const name = rest[1] ?? '';
  if (name === '') throw general('lane new 需要车道名', '例如: cowork lane new auth');
  const result = laneNew(info, name, value(args, 'base'));
  console.log(`已创建车道 ${result.name}: ${result.path}`);
  console.log(`  branch: ${result.branch}（base ${result.base}）`);
  console.log(`  cd ${result.path}`);
  console.log(`  建议: COWORK_AGENT_ID=${result.name}`);
  return EXIT.OK;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const { command, rest, flags } = args;
  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (command === '--version' || command === '-v') {
    console.log('cowork 0.0.0 (M1)');
    return EXIT.OK;
  }
  if (command === '' || flags.has('help') || command === 'help') {
    console.log(USAGE);
    return command === '' ? EXIT.GENERAL : EXIT.OK;
  }
  if (command === 'version') {
    console.log('cowork 0.0.0 (M1)');
    return EXIT.OK;
  }
  if (!KNOWN_COMMANDS.has(command)) {
    throw general(`未知命令: ${command}`, '运行 cowork --help 查看可用命令。');
  }

  const info = needRepo();
  switch (command) {
    case 'init':
      return runInit(info);
    case 'claim':
      if (rest.length === 0) throw general('没有指定路径', '用法: cowork claim <文件或目录前缀>...');
      return runClaim(info, rest, args);
    case 'release':
      return runRelease(info, rest, flags.has('force'));
    case 'status':
      return runStatus(info, flags.has('json'));
    case 'merge': {
      if (!flags.has('dry-run') || rest.length !== 1 || args.flags.has('base')) {
        throw general('merge 需要 --dry-run 和一个车道', '用法: cowork merge --dry-run <lane> [--base <ref>] [--json]');
      }
      const preview = previewMerge(info, rest[0]!, value(args, 'base') ?? undefined);
      console.log(flags.has('json') ? JSON.stringify(preview, null, 2) : renderMergePreview(preview));
      return preview.can_merge ? EXIT.OK : EXIT.BUSY;
    }
    case 'snapshot':
      return runSnapshot(info, flags.has('json'));
    case 'ui':
      return runUi(info, args);
    case 'task':
      return runTask(info, args, rest);
    case 'next':
      return runNext(info, args);
    case 'lane':
      return runLane(info, args, rest);
    case 'brief':
      return runBrief(info, args);
    case 'doctor':
      return runDoctor(info, flags.has('fix'));
    default:
      throw general(`未知命令: ${command}`, '运行 cowork --help 查看可用命令。');
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    err = pathError(err, process.cwd()) ?? err;
    if (err instanceof CoworkError) {
      console.error(`cowork: ${err.message}`);
      if (err.hint !== undefined) console.error(`  → ${err.hint}`);
      process.exitCode = err.code;
      return;
    }
    console.error(`cowork: 未预期的错误: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT.GENERAL;
  },
);
