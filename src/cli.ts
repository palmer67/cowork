#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claim, doctorFix, expiresAt, release, status } from './claims.ts';
import { CoworkError, EXIT, general } from './errors.ts';
import { currentBranch, headCommit, repoInfo, type RepoInfo } from './git.ts';
import { snapshot, type Snapshot } from './snapshot.ts';
import { stateRoot, type ClaimRecord } from './store.ts';
import { DEFAULT_WATCH_INTERVAL_MS, openPanel, watchPanel, writePanel } from './ui.ts';

const USAGE = `cowork — 多 agent 同仓协作纪律层

用法:
  cowork init                     初始化仓库内的 .cowork/ 与配置
  cowork claim <路径>...          占位（精确文件或目录前缀，目录可写 dir/**）
  cowork release [<路径>...]      释放占位（省略路径则释放本工作树全部）
  cowork status [--json]          查看当前全部占位
  cowork snapshot [--json]        只读快照：车道、未提交改动与占位
  cowork ui [--out <路径>] [--open]
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
  values: Map<string, string>;
}

/** 只需要 `--flag`、`--key=value` 和值型 flag（`--note <文本>`、`--out <路径>`、`--interval <秒>`）。 */
const VALUE_FLAGS = new Set(['note', 'out', 'interval']);

function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...tail] = argv;
  const rest: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < tail.length; i += 1) {
    const item = tail[i] as string;
    if (!item.startsWith('--')) {
      rest.push(item);
      continue;
    }
    const body = item.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = tail[i + 1];
    if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      values.set(body, next);
      i += 1;
      continue;
    }
    flags.add(body);
  }
  return { command, rest, flags, values };
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
  const note = args.values.get('note');
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

function groupByLane(claims: readonly { lane: string | null; lanePath: string }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const rec of claims) {
    const key = rec.lane === null ? '(主工作树)' : rec.lane;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function describeAgent(rec: ClaimRecord): string {
  const who = rec.agentId === 'default' ? '' : ` agent=${rec.agentId}`;
  return `pid ${rec.pid}@${rec.host}${who}`;
}

async function runStatus(info: RepoInfo, json: boolean): Promise<number> {
  const report = await status(info);
  if (json) {
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      repo: { root: report.mainRoot, head: headCommit(info.laneTop) },
      this: { lane: report.lane, path: report.laneTop, agent: report.agent },
      claims: report.claims.map((rec) => ({
        path: rec.display,
        kind: rec.kind,
        lane: rec.lane,
        branch: rec.branch,
        agent: rec.agentId,
        pid: rec.pid,
        host: rec.host,
        note: rec.note,
        createdAt: rec.createdAt,
        expiresAt: expiresAt(rec),
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return EXIT.OK;
  }

  console.log(`仓库: ${report.mainRoot}`);
  console.log(`本工作树: ${report.lane === null ? '(主工作树)' : `lane ${report.lane}`}  agent=${report.agent}`);
  console.log(`live 状态: ${report.state}`);
  console.log('');
  if (report.claims.length === 0) {
    console.log('当前没有任何占位。');
    return EXIT.OK;
  }
  const width = Math.max(...report.claims.map((rec) => rec.display.length), 4);
  console.log(`${'路径'.padEnd(width)}  车道           占用者                                 过期时间`);
  for (const rec of report.claims) {
    const who = `${rec.lane === null ? '(主)' : rec.lane}`;
    console.log(
      `${rec.display.padEnd(width)}  ${who.padEnd(14)} ${describeAgent(rec).padEnd(38)} ${expiresAt(rec)}`,
    );
    if (rec.note !== null) console.log(`${' '.repeat(width)}  ↳ ${rec.note}`);
  }
  console.log('');
  const byLane = groupByLane(report.claims);
  for (const [lane, count] of byLane) console.log(`${lane}: ${count} 个占位`);
  if (report.expired.length > 0) {
    console.log('');
    console.log(`发现 ${report.expired.length} 个已过期占位，运行 cowork doctor --fix 清理。`);
  }
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
  const out = args.values.get('out');
  const watching = args.flags.has('watch');
  if (!watching && args.values.has('interval')) {
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

  const seconds = parseInterval(args.values.get('interval'));
  const controller = new AbortController();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('正在停止 watch…');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
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
    console.log(`已停止。面板: ${file}`);
    return EXIT.OK;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function runDoctor(info: RepoInfo, fix: boolean): Promise<number> {
  console.log(`主仓库: ${info.mainRoot}`);
  console.log(`共享 git 目录: ${info.commonDir}`);
  console.log(`live 状态: ${stateRoot(info)}`);
  if (!existsSync(stateRoot(info))) {
    console.log('状态目录尚未创建（还没运行过任何占位命令）。');
    return EXIT.OK;
  }
  if (!fix) {
    const report = await status(info);
    if (report.expired.length === 0) {
      console.log('未发现过期占位。');
      return EXIT.OK;
    }
    console.log(`发现 ${report.expired.length} 个已过期占位:`);
    for (const rec of report.expired) console.log(`  ${rec.display}  ${rec.createdAt}  ${describeAgent(rec)}`);
    console.log('运行 cowork doctor --fix 清理。');
    return EXIT.OK;
  }
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
  return EXIT.OK;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const { command, rest, flags } = args;
  if (command === '' || flags.has('help') || command === 'help') {
    console.log(USAGE);
    return command === '' ? EXIT.GENERAL : EXIT.OK;
  }
  if (command === 'version') {
    console.log('cowork 0.0.0 (M0)');
    return EXIT.OK;
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
    case 'snapshot':
      return runSnapshot(info, flags.has('json'));
    case 'ui':
      return runUi(info, args);
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
