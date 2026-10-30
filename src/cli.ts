#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claim, doctorFix, expiresAt, release, status } from './claims.ts';
import { CoworkError, EXIT, general } from './errors.ts';
import { currentBranch, headCommit, repoInfo, type RepoInfo } from './git.ts';
import { stateRoot, type ClaimRecord } from './store.ts';

const USAGE = `cowork — 多 agent 同仓协作纪律层

用法:
  cowork init                     初始化仓库内的 .cowork/ 与配置
  cowork claim <路径>...          占位（精确文件或目录前缀，目录可写 dir/**）
  cowork release [<路径>...]      释放占位（省略路径则释放本工作树全部）
  cowork status [--json]          查看当前全部占位
  cowork doctor [--fix]           检查状态目录与残留占位
  cowork version                  版本

退出码: 0 成功 / 1 一般错误 / 2 被占用或冲突 / 3 环境不满足`;

interface Args {
  command: string;
  rest: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

/** 只需要 `--flag`、`--key=value` 和 `--note <文本>` 三种形式。 */
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
    if (body === 'note' && next !== undefined && !next.startsWith('--')) {
      values.set('note', next);
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
  const pruned = await doctorFix(info);
  for (const rec of pruned) console.log(`已清理 ${rec.display}（${describeAgent(rec)}，已过期）`);
  if (pruned.length === 0) console.log('未发现过期占位。');
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
