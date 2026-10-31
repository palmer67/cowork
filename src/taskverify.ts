import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { busy, general } from './errors.ts';
import { git, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { agentId, isExpired } from './claims.ts';
import { claimId, listClaims, readClaim, stateRoot } from './store.ts';
import { formatClaim, parseClaim } from './paths.ts';
import { readTaskLive, transitionM2Task, writeTaskLive, type TaskLive, type VerificationLive, type VerificationRecord } from './taskstore.ts';
import { isTaskId, parseTaskSpec, readTrunk } from './tasks.ts';
import { recoverIntents } from './tasknext.ts';

const execFileAsync = promisify(execFile);
const MAX_SUMMARY_BYTES = 2048;
const BUILTIN_ENV = new Set(['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'CI', 'NODE_ENV', 'COWORK_AGENT_ID']);

interface VerificationCommand {
  name: string;
  argv: string[];
  timeout_ms: number;
  enabled: boolean;
}

interface VerificationConfig {
  allow_disabled: boolean;
  commands: VerificationCommand[];
  env_allowlist: string[];
}

interface GitSnapshot {
  trunk: string;
  trunkSha: string;
  config: VerificationConfig;
  head: string;
  dirty: boolean;
  spec: ReturnType<typeof parseTaskSpec>;
}

interface CommandResult {
  spawned: boolean;
  pid: number | null;
  exit: number | null;
  timedOut: boolean;
  duration: number;
  output: string;
  error: string | null;
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortSummary(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= MAX_SUMMARY_BYTES) return value;
  let start = bytes.length - MAX_SUMMARY_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function parseVerificationConfig(rawText: string, source: string): VerificationConfig {
  let root: unknown;
  try {
    root = JSON.parse(rawText);
  } catch (err) {
    throw general(`验证配置不是合法 JSON（${source}: ${detail(err)}）`, '修正 trunk commit 中的 .cowork/config.json 后重试。');
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw general(`验证配置格式错误（${source}）`, 'trunk 的 .cowork/config.json 必须是 JSON 对象。');
  }
  const value = (root as Record<string, unknown>)['verification'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw general(`trunk 验证配置缺失或格式错误（${source}）`, '在 trunk 的 .cowork/config.json 配置 verification.allow_disabled、commands 和 env_allowlist。');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['allow_disabled'] !== 'boolean') throw general('verification.allow_disabled 必须是布尔值');
  const commands = record['commands'];
  if (!Array.isArray(commands) || commands.length === 0) throw general('verification.commands 必须是非空数组');
  const names = new Set<string>();
  const parsedCommands: VerificationCommand[] = commands.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw general(`verification.commands[${index}] 必须是对象`);
    const command = item as Record<string, unknown>;
    const name = command['name'];
    const argv = command['argv'];
    const timeout = command['timeout_ms'];
    const enabled = command['enabled'];
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || names.has(name)) {
      throw general(`verification.commands[${index}].name 无效或重复`);
    }
    names.add(name);
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part === '')) {
      throw general(`verification.commands[${index}].argv 必须是非空字符串数组`);
    }
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000) {
      throw general(`verification.commands[${index}].timeout_ms 必须是 1..3600000 的整数`);
    }
    if (typeof enabled !== 'boolean') throw general(`verification.commands[${index}].enabled 必须是布尔值`);
    if (!record['allow_disabled'] && !enabled) throw general(`验证命令 ${name} 被禁用；需显式设置 allow_disabled=true`);
    if (/\.(cmd|bat)$/i.test(argv[0] as string)) throw general(`验证命令 ${name} 不能通过 .cmd/.bat 包装器启动`);
    return { name, argv: argv as string[], timeout_ms: timeout, enabled };
  });
  if (!parsedCommands.some((command) => command.enabled)) throw general('至少要启用一项验证命令');
  const envAllowlist = record['env_allowlist'];
  if (!Array.isArray(envAllowlist) || envAllowlist.some((key) => typeof key !== 'string')) {
    throw general('verification.env_allowlist 必须是字符串数组');
  }
  const unique = [...new Set(envAllowlist as string[])];
  const invalid = unique.find((key) => !BUILTIN_ENV.has(key));
  if (invalid !== undefined) throw general(`verification.env_allowlist 不允许环境变量: ${invalid}`);
  return { allow_disabled: record['allow_disabled'], commands: parsedCommands, env_allowlist: unique };
}

function readGitSnapshot(info: RepoInfo, id: string): GitSnapshot {
  const trunk = readTrunk(info);
  let trunkSha: string;
  let configText: string;
  try {
    trunkSha = git(['rev-parse', '--verify', `${trunk}^{commit}`], info.mainRoot);
    configText = git(['show', `${trunkSha}:.cowork/config.json`], info.mainRoot);
  } catch (err) {
    throw general(`无法读取 trunk 验证配置（${detail(err)}）`, '确认 trunk ref 存在且该提交包含 .cowork/config.json。');
  }
  const config = parseVerificationConfig(configText, `${trunk}@${trunkSha}`);
  try {
    const specText = git(['show', `${trunkSha}:.cowork/tasks/${id}.md`], info.mainRoot);
    const spec = parseTaskSpec(specText, `.cowork/tasks/${id}.md@${trunkSha}`, info, trunkSha);
    const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], info.laneTop);
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], info.laneTop);
    return { trunk, trunkSha, config, head, dirty: status !== '', spec };
  } catch (err) {
    throw general(`无法读取验证工作树快照（${detail(err)}）`, '确认 task done 在有效的 Git worktree 中运行。');
  }
}

function verificationEnvironment(config: VerificationConfig, agent: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of config.env_allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env['COWORK_AGENT_ID'] = agent;
  return env;
}

function requireOwnerAndClaims(info: RepoInfo, state: string, live: TaskLive, agent: string, touches: readonly string[]): void {
  if (live.agent !== agent) {
    const owner = live.agent ?? '未声明';
    throw general(`任务 ${live.id} 当前由 ${owner} 持有，task done 需要 owner=${live.agent ?? '(无)'}`, `在所属车道使用 COWORK_AGENT_ID=${owner} 后重试。`);
  }
  if (live.lanePath === null || path.resolve(live.lanePath) !== path.resolve(info.laneTop) || live.lane !== info.laneName) {
    throw general(
      `task done 必须在任务所属 worktree 运行（记录 lane=${live.lane ?? '(main)'} path=${live.lanePath ?? '(无)'}；当前 lane=${info.laneName ?? '(main)'} path=${info.laneTop}）`,
      '切换到 live 记录的 assigned_lane 后重试。',
    );
  }
  for (const raw of touches) {
    const target = parseClaim(raw, info);
    const claim = readClaim(state, claimId(target));
    if (
      claim === null || isExpired(claim, Date.now()) || claim.note !== `task ${live.id}` ||
      claim.agentId !== live.agent || claim.lane !== live.lane || path.resolve(claim.lanePath) !== path.resolve(live.lanePath)
    ) {
      throw general(`任务 ${live.id} 缺少有效 touches 占位: ${formatClaim(target)}`, '由 owner 在 assigned_lane 中重新运行 cowork task done；占位只能由对应任务 next 生成。');
    }
  }
}

function withTaskLock<T>(info: RepoInfo, fn: (state: string) => T | Promise<T>): Promise<T> {
  const state = stateRoot(info);
  return withLock(state, async () => {
    recoverIntents(state);
    return await fn(state);
  });
}

function requireRun(state: string, id: string, runId: string): TaskLive {
  const live = readTaskLive(state, id);
  if (live === null || (live.status !== 'verifying' && live.status !== 'blocked') || live.verification?.run_id !== runId) {
    throw busy(`验证事务已被替换: ${id} (${runId})`, '重新运行 cowork task show；不要覆盖当前 live 状态。');
  }
  return live;
}

function pidStartTime(pid: number): Promise<{ at: string | null; error: string | null }> {
  if (process.platform !== 'win32') return Promise.resolve({ at: null, error: 'PowerShell PID 启动时间查询仅在 Windows 提供' });
  const script = "$p=Get-Process -Id ([int]$env:COWORK_PID) -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o')";
  const env = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    COWORK_PID: String(pid),
  };
  return execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false, env,
  }).then(({ stdout }) => ({ at: stdout.trim() || null, error: stdout.trim() ? null : 'PowerShell 未返回启动时间' }))
    .catch((err: unknown) => ({ at: null, error: detail(err) }));
}

async function recordProgress(info: RepoInfo, id: string, runId: string, verification: VerificationLive): Promise<void> {
  await withTaskLock(info, (state) => {
    const live = requireRun(state, id, runId);
    writeTaskLive(state, { ...live, updated_at: new Date().toISOString(), verification });
  });
}

function runCommand(
  command: VerificationCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onSpawn: (pid: number) => Promise<void>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let spawned = false;
    let timedOut = false;
    let pid: number | null = null;
    let spawnError: string | null = null;
    let progress = Promise.resolve();
    const child = execFile(command.argv[0]!, command.argv.slice(1), {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      clearTimeout(timer);
      void progress.then(() => {
        const output = `${String(stdout ?? '')}${String(stderr ?? '')}`;
        const error = !spawned ? spawnError ?? detail(err) : err === null ? null : detail(err);
        const exit = !spawned || timedOut ? null : typeof err?.code === 'number' ? err.code : err === null ? 0 : 1;
        resolve({ spawned, pid, exit, timedOut, duration: Date.now() - started, output, error });
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, command.timeout_ms);
    child.once('spawn', () => {
      spawned = true;
      pid = child.pid ?? null;
      if (pid !== null) progress = onSpawn(pid).catch((err: unknown) => { spawnError = `live PID 写入失败: ${detail(err)}`; });
    });
    child.once('error', (err) => {
      if (!spawned) spawnError = detail(err);
    });
  });
}

function initialStatusError(id: string, status: string): never {
  if (status === 'verifying') throw busy(`任务 ${id} 正在验证中`, '等待当前验证结束后再看状态；不要并发重复 task done。');
  if (status === 'in_progress' || status === 'merged' || status === 'cancelled') {
    throw general(`任务 ${id} 当前状态为 ${status}，不能 task done`, status === 'in_progress' ? '先运行 cowork task report-done，再执行 cowork task done。' : '当前状态没有 task done 后续操作。');
  }
  throw general(`任务 ${id} 当前状态为 ${status}，不能 task done`, '只有 reported_done 或 verify_failed 可以运行 cowork task done。');
}

export interface TaskDoneResult {
  live: TaskLive;
  passed: boolean;
  message: string;
  output: string;
}

export async function taskDone(info: RepoInfo, id: string, agent = agentId()): Promise<TaskDoneResult> {
  if (!isTaskId(id)) throw general(`任务 id 不合法: ${id}`, '使用 cowork task ls 查看有效任务 id。');

  const observed = readTaskLive(stateRoot(info), id);
  if (observed === null) throw general(`任务没有 live 记录: ${id}`, '先 cowork task ready 并由 assigned_lane 执行 cowork next。');
  if (observed.status !== 'reported_done' && observed.status !== 'verify_failed') initialStatusError(id, observed.status);

  let first: GitSnapshot;
  try {
    first = readGitSnapshot(info, id);
    if (first.dirty) throw general('task done 前工作树不干净', '提交或手动处理全部 tracked 与 untracked 改动后重试；cowork 不会清理文件。');
  } catch (err) {
    if (err instanceof Error && 'code' in err) throw err;
    throw general(`task done 初始检查失败: ${detail(err)}`, '修复 trunk 配置或 Git 读取问题后重试。');
  }
  const spec = first.spec;
  const runId = `verify-${Date.now()}-${randomBytes(5).toString('hex')}`;
  const startedAt = new Date().toISOString();
  let verification: VerificationLive = {
    run_id: runId, status: 'running', pid: null, host: null,
    pid_started_at: null, pid_start_error: null, started_at: startedAt,
    finished_at: null, head_before: first.head, head_after: null,
    config_commit: first.trunkSha, summary: '', records: [],
  };

  await withTaskLock(info, (state) => {
    const live = readTaskLive(state, id);
    if (live === null) throw general(`任务没有 live 记录: ${id}`, '先 cowork task ready 并由 assigned_lane 执行 cowork next。');
    if (live.status !== 'reported_done' && live.status !== 'verify_failed') initialStatusError(id, live.status);
    requireOwnerAndClaims(info, state, live, agent, spec.touches);
    transitionM2Task(state, id, 'verifying', {
      agent,
      note: `task done ${runId}`,
      verification,
      recovery: null,
    });
  });

  const env = verificationEnvironment(first.config, agent);
  let spawnFailure: VerificationRecord | null = null;
  let commandFailure: string | null = null;
  const fullOutput: string[] = [];
  for (const command of first.config.commands) {
    if (!command.enabled) {
      const skipped: VerificationRecord = {
        name: command.name, argv: command.argv, exit: 0, timed_out: false,
        duration_ms: 0, head: first.head, summary: 'allow_disabled=true，按配置跳过', at: new Date().toISOString(), skipped: true,
      };
      verification = { ...verification, records: [...verification.records, skipped] };
      await recordProgress(info, id, runId, verification);
      continue;
    }

    const commandStarted = Date.now();
    let runningRecordIndex = -1;
    const result = await runCommand(command, info.laneTop, env, async (pid) => {
      const records = [...verification.records];
      runningRecordIndex = records.length;
      records.push({
        name: command.name, argv: command.argv, exit: null, timed_out: false,
        duration_ms: Date.now() - commandStarted, head: first.head, summary: '',
        at: new Date(commandStarted).toISOString(),
      });
      verification = {
        ...verification,
        pid,
        host: hostname(),
        pid_started_at: null,
        pid_start_error: null,
        records,
      };
      await recordProgress(info, id, runId, verification);
      const started = await readPidStartedAt(pid);
      verification = {
        ...verification,
        pid_started_at: started.at,
        pid_start_error: started.error,
      };
      await recordProgress(info, id, runId, verification);
    });
    const record: VerificationRecord = {
      name: command.name, argv: command.argv, exit: result.exit,
      timed_out: result.timedOut, duration_ms: result.duration,
      head: first.head, summary: shortSummary(result.output || result.error || ''), at: new Date().toISOString(),
      ...(!result.spawned ? { error: 'spawn' as const } : {}),
    };
    if (result.output !== '') fullOutput.push(`$ ${command.argv.join(' ')}\n${result.output}`);
    if (result.error !== null && result.output === '') fullOutput.push(`$ ${command.argv.join(' ')}\n${result.error}`);
    const records = [...verification.records];
    if (result.spawned && runningRecordIndex >= 0) records[runningRecordIndex] = record;
    else records.push(record);
    verification = { ...verification, pid: result.pid, records };
    if (verification.pid_start_error === null && result.spawned && result.pid !== null) {
      verification = { ...verification, pid_start_error: null };
    }
    await recordProgress(info, id, runId, verification);
    if (!result.spawned) {
      spawnFailure = record;
      commandFailure = result.error ?? 'spawn failed';
      break;
    }
    if (result.exit !== 0) {
      commandFailure = result.timedOut
        ? `${command.name} 超时 (${command.timeout_ms}ms)`
        : `${command.name} 退出 ${String(result.exit)}${result.error === null ? '' : `: ${result.error}`}`;
      break;
    }
  }

  let second: GitSnapshot | null = null;
  let snapshotError: string | null = null;
  try {
    second = readGitSnapshot(info, id);
  } catch (err) {
    snapshotError = detail(err);
  }

  return withTaskLock(info, (state) => {
    const live = requireRun(state, id, runId);
    requireOwnerAndClaims(info, state, live, agent, spec.touches);
    const remainsBlocked = live.status === 'blocked';
    const finishedAt = new Date().toISOString();
    const headAfter = second?.head ?? null;
    if (spawnFailure !== null) {
      const reason = `验证命令 ${spawnFailure.name} 启动失败: ${commandFailure ?? 'spawn failed'}`;
      verification = {
        ...verification, status: 'failed', finished_at: finishedAt, head_after: headAfter,
        summary: shortSummary(reason), pid: null,
      };
      const restored = remainsBlocked
        ? { ...live, updated_at: finishedAt, verification }
        : transitionM2Task(state, id, 'reported_done', {
          agent, note: '验证命令 spawn 失败，恢复 reported_done', verification,
        });
      if (remainsBlocked) writeTaskLive(state, restored);
      return { live: restored, passed: false, message: reason, output: fullOutput.join('\n') };
    }

    const changed = second === null || first.head !== second.head || second.dirty ||
      first.trunkSha !== second.trunkSha || first.config.commands.map((item) => JSON.stringify(item)).join('\n') !==
      second.config.commands.map((item) => JSON.stringify(item)).join('\n') ||
      first.config.env_allowlist.join('\0') !== second.config.env_allowlist.join('\0') ||
      first.config.allow_disabled !== second.config.allow_disabled;
    const failed = commandFailure !== null || snapshotError !== null || changed;
    const reasons = [
      commandFailure,
      snapshotError === null ? null : `验证后 Git 快照失败: ${snapshotError}`,
      changed ? `验证前后快照不一致或验证后工作树 dirty（HEAD ${first.head} → ${headAfter ?? '?'}）` : null,
    ].filter((item): item is string => item !== null);
    const message = failed ? reasons.join('; ') : `验证通过（config_commit ${first.trunkSha}）`;
    verification = {
      ...verification,
      status: failed ? 'failed' : 'passed',
      finished_at: finishedAt,
      head_after: headAfter,
      summary: shortSummary([
        message,
        ...verification.records.map((record) => `${record.name}: ${record.skipped ? 'skipped' : `exit=${String(record.exit)} ${record.summary}`}`),
      ].join('\n')),
      pid: null,
      host: verification.host ?? hostname(),
    };
    if (remainsBlocked) {
      const blocked = { ...live, updated_at: finishedAt, verification };
      writeTaskLive(state, blocked);
      return { live: blocked, passed: false, message: `任务保持 blocked；${message}`, output: fullOutput.join('\n') };
    }
    const result = transitionM2Task(state, id, failed ? 'verify_failed' : 'awaiting_merge', { agent, note: message, verification });
    return { live: result, passed: !failed, message, output: fullOutput.join('\n') };
  });
}
