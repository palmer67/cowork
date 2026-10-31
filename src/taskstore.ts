import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { general, CoworkError } from './errors.ts';
import type { RepoInfo } from './git.ts';
import { stateRoot, readStateDir } from './store.ts';
import type { TaskStatus } from './tasks.ts';
import { assertTransition, isTaskId, isTaskStatus } from './tasks.ts';

/**
 * 运行态（live）：<common-dir>/cowork/tasks/<id>.json，不提交。
 * 记录 status/lease/agent/spec_commit/history；绝不写回 spec。
 */

/** corrupt 是 fail-closed 标记：事务回滚失败时使用，不开放给第二个 owner。 */
export type LiveStatus = TaskStatus | 'corrupt';

export type VerificationStatus = 'running' | 'passed' | 'failed' | 'stale';

export interface VerificationRecord {
  name: string;
  argv: string[];
  exit: number | null;
  timed_out: boolean;
  duration_ms: number;
  head: string | null;
  summary: string;
  at: string;
  error?: 'spawn';
  skipped?: boolean;
}

export interface VerificationLive {
  run_id: string;
  status: VerificationStatus;
  pid: number | null;
  host: string | null;
  pid_started_at: string | null;
  pid_start_error: string | null;
  started_at: string;
  finished_at: string | null;
  head_before: string | null;
  head_after: string | null;
  config_commit: string;
  summary: string;
  records: VerificationRecord[];
}

export interface TaskRecovery {
  at: string;
  run_id: string;
  reason: string;
}

export interface TaskHistoryEntry {
  at: string;
  from: LiveStatus | null;
  to: LiveStatus;
  agent: string | null;
  note: string | null;
}

export interface TaskLive {
  schemaVersion: 1;
  id: string;
  status: LiveStatus;
  /** task lease 的持有者；null 表示还没被领取。 */
  lane: string | null;
  lanePath: string | null;
  agent: string | null;
  spec_commit: string | null;
  created_at: string;
  updated_at: string;
  blocked_reason: string | null;
  verification: VerificationLive | null;
  recovery: TaskRecovery | null;
  history: TaskHistoryEntry[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function taskLiveDir(state: string): string {
  return path.join(state, 'tasks');
}

export function taskLiveFile(state: string, id: string): string {
  return path.join(taskLiveDir(state), `${id}.json`);
}

function corruptFile(file: string, detail: string): Error {
  return general(
    `任务状态文件损坏: ${file}（${detail}）`,
    '运行 cowork doctor --fix 隔离损坏文件；再运行 cowork task show 确认任务状态。',
  );
}

function asString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string') throw corruptFile(file, `${field} 必须是字符串`);
  return value;
}

function asNullableString(value: unknown, field: string, file: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw corruptFile(file, `${field} 必须是字符串或 null`);
  return value;
}

function asLiveStatus(value: unknown, file: string): LiveStatus {
  if (value === 'corrupt') return 'corrupt';
  if (!isTaskStatus(value)) throw corruptFile(file, `status 不是合法状态: ${JSON.stringify(value)}`);
  return value;
}

function asHistory(raw: unknown, file: string): TaskHistoryEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw corruptFile(file, 'history 必须是数组');
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw corruptFile(file, `history[${index}] 不是对象`);
    }
    const record = entry as Record<string, unknown>;
    const from = record['from'];
    return {
      at: asString(record['at'], `history[${index}].at`, file),
      from: from === null || from === undefined ? null : asLiveStatus(from, file),
      to: asLiveStatus(record['to'], file),
      agent: asNullableString(record['agent'], `history[${index}].agent`, file),
      note: asNullableString(record['note'], `history[${index}].note`, file),
    };
  });
}

function asVerification(raw: unknown, file: string): VerificationLive | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw corruptFile(file, 'verification 必须是对象或 null');
  const record = raw as Record<string, unknown>;
  const status = record['status'];
  if (!['running', 'passed', 'failed', 'stale'].includes(String(status))) {
    throw corruptFile(file, `verification.status 不合法: ${JSON.stringify(status)}`);
  }
  const pid = record['pid'];
  if (pid !== null && pid !== undefined && (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)) {
    throw corruptFile(file, 'verification.pid 必须是正整数或 null');
  }
  const records = record['records'];
  if (!Array.isArray(records)) throw corruptFile(file, 'verification.records 必须是数组');
  return {
    run_id: asString(record['run_id'], 'verification.run_id', file),
    status: status as VerificationStatus,
    pid: pid === undefined || pid === null ? null : pid as number,
    host: asNullableString(record['host'], 'verification.host', file),
    pid_started_at: asNullableString(record['pid_started_at'], 'verification.pid_started_at', file),
    pid_start_error: asNullableString(record['pid_start_error'], 'verification.pid_start_error', file),
    started_at: asString(record['started_at'], 'verification.started_at', file),
    finished_at: asNullableString(record['finished_at'], 'verification.finished_at', file),
    head_before: asNullableString(record['head_before'], 'verification.head_before', file),
    head_after: asNullableString(record['head_after'], 'verification.head_after', file),
    config_commit: asString(record['config_commit'], 'verification.config_commit', file),
    summary: asString(record['summary'], 'verification.summary', file),
    records: records.map((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw corruptFile(file, `verification.records[${index}] 必须是对象`);
      }
      const value = item as Record<string, unknown>;
      const argv = value['argv'];
      if (!Array.isArray(argv) || argv.some((part) => typeof part !== 'string')) {
        throw corruptFile(file, `verification.records[${index}].argv 必须是字符串数组`);
      }
      const exit = value['exit'];
      if (exit !== null && (typeof exit !== 'number' || !Number.isInteger(exit))) {
        throw corruptFile(file, `verification.records[${index}].exit 必须是整数或 null`);
      }
      const duration = value['duration_ms'];
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        throw corruptFile(file, `verification.records[${index}].duration_ms 必须是非负数`);
      }
      if (typeof value['timed_out'] !== 'boolean') throw corruptFile(file, `verification.records[${index}].timed_out 必须是布尔值`);
      if (value['error'] !== undefined && value['error'] !== 'spawn') throw corruptFile(file, `verification.records[${index}].error 不合法`);
      if (value['skipped'] !== undefined && typeof value['skipped'] !== 'boolean') throw corruptFile(file, `verification.records[${index}].skipped 必须是布尔值`);
      return {
        name: asString(value['name'], `verification.records[${index}].name`, file),
        argv: argv as string[],
        exit: exit as number | null,
        timed_out: value['timed_out'] as boolean,
        duration_ms: duration,
        head: asNullableString(value['head'], `verification.records[${index}].head`, file),
        summary: asString(value['summary'], `verification.records[${index}].summary`, file),
        at: asString(value['at'], `verification.records[${index}].at`, file),
        ...(value['error'] === undefined ? {} : { error: 'spawn' as const }),
        ...(value['skipped'] === undefined ? {} : { skipped: value['skipped'] as boolean }),
      };
    }),
  };
}

function asRecovery(raw: unknown, file: string): TaskRecovery | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw corruptFile(file, 'recovery 必须是对象或 null');
  const record = raw as Record<string, unknown>;
  return {
    at: asString(record['at'], 'recovery.at', file),
    run_id: asString(record['run_id'], 'recovery.run_id', file),
    reason: asString(record['reason'], 'recovery.reason', file),
  };
}

function asTaskLive(raw: unknown, file: string): TaskLive {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw corruptFile(file, '不是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) {
    throw corruptFile(file, `schemaVersion 必须是 1（读到 ${JSON.stringify(record['schemaVersion'])}）`);
  }
  const id = asString(record['id'], 'id', file);
  if (!isTaskId(id)) throw corruptFile(file, `id 不合法: ${id}`);
  return {
    schemaVersion: 1,
    id,
    status: asLiveStatus(record['status'], file),
    lane: asNullableString(record['lane'], 'lane', file),
    lanePath: asNullableString(record['lanePath'], 'lanePath', file),
    agent: asNullableString(record['agent'], 'agent', file),
    spec_commit: asNullableString(record['spec_commit'], 'spec_commit', file),
    created_at: asString(record['created_at'], 'created_at', file),
    updated_at: asString(record['updated_at'], 'updated_at', file),
    blocked_reason: asNullableString(record['blocked_reason'], 'blocked_reason', file),
    verification: asVerification(record['verification'], file),
    recovery: asRecovery(record['recovery'], file),
    history: asHistory(record['history'], file),
  };
}

/** 读单个 live；文件不存在返回 null（等价 draft）。坏数据抛 exit 1。 */
export function readTaskLive(state: string, id: string): TaskLive | null {
  const file = taskLiveFile(state, id);
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw corruptFile(file, `无法读取（${message(err)}）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw corruptFile(file, `不是合法 JSON（${message(err)}）`);
  }
  return asTaskLive(raw, file);
}

/** 原子写：tmp + rename，避免并发读者看到半截 JSON。 */
export function writeTaskLive(state: string, live: TaskLive): void {
  const file = taskLiveFile(state, live.id);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (err instanceof CoworkError) throw err;
    throw general(`无法写入任务状态: ${file}（${message(err)}）`, '检查 .git/cowork/tasks 是否可写、磁盘是否已满。');
  }
}

/** 列出全部 live；坏文件抛错（调用方用 listTaskLiveStates 做诊断视图）。 */
export function listTaskLive(state: string): TaskLive[] {
  const dir = taskLiveDir(state);
  return readStateDir(dir)
    .filter((name) => /^t-[0-9a-f]{6}\.json$/.test(name))
    .map((name) => readTaskLive(state, name.slice(0, -5)))
    .filter((live): live is TaskLive => live !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** snapshot/doctor 用：坏 live 变成诊断项，不拖垮整份视图。 */
export interface TaskLiveStates {
  lives: TaskLive[];
  corrupt: { file: string; id: string; error: string }[];
}

export function listTaskLiveStates(state: string): TaskLiveStates {
  const dir = taskLiveDir(state);
  const names = readStateDir(dir);
  const lives: TaskLive[] = [];
  const corrupt: { file: string; id: string; error: string }[] = [];
  for (const name of names.filter((item) => /^t-[0-9a-f]{6}\.json$/.test(item)).sort()) {
    const id = name.slice(0, -5);
    try {
      const live = readTaskLive(state, id);
      if (live !== null) lives.push(live);
    } catch (err) {
      corrupt.push({ file: taskLiveFile(state, id), id, error: message(err) });
    }
  }
  return { lives, corrupt };
}

export interface TransitionOptions {
  agent?: string | null;
  note?: string | null;
  lane?: string | null;
  lanePath?: string | null;
  specCommit?: string | null;
  reason?: string | null;
}

export interface M2TransitionOptions extends TransitionOptions {
  verification?: VerificationLive | null;
  recovery?: TaskRecovery | null;
  historyAgent?: string | null;
}

const M2_TRANSITIONS: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
  reported_done: ['verifying', 'blocked'],
  verify_failed: ['verifying', 'blocked'],
  verifying: ['reported_done', 'verify_failed', 'awaiting_merge', 'blocked'],
  awaiting_merge: ['merged', 'blocked'],
};

/** M2 专用状态入口；旧 assertTransition 保持 M1 语义。 */
export function transitionM2Task(
  state: string,
  id: string,
  to: TaskStatus,
  options: M2TransitionOptions = {},
): TaskLive {
  const current = readTaskLive(state, id);
  if (current === null || current.status === 'corrupt') {
    throw general(`M2 状态转换缺少有效 live: ${id}`, '先确认任务已 ready 并由 owner 领取。');
  }
  const allowed = M2_TRANSITIONS[current.status as TaskStatus] ?? [];
  if (!allowed.includes(to)) {
    throw general(
      `非法 M2 状态转换: ${current.status} → ${to}`,
      `当前状态 ${current.status} 不允许此操作；仅允许 ${allowed.join(', ') || '无'}。`,
    );
  }
  const now = new Date().toISOString();
  const next: TaskLive = {
    ...current,
    status: to,
    lane: options.lane !== undefined ? options.lane : current.lane,
    lanePath: options.lanePath !== undefined ? options.lanePath : current.lanePath,
    agent: options.agent !== undefined ? options.agent : current.agent,
    spec_commit: options.specCommit !== undefined ? options.specCommit : current.spec_commit,
    updated_at: now,
    blocked_reason: to === 'blocked' ? options.reason ?? null : null,
    verification: options.verification !== undefined ? options.verification : current.verification,
    recovery: options.recovery !== undefined ? options.recovery : current.recovery,
    history: [
      ...current.history,
      { at: now, from: current.status, to, agent: options.historyAgent ?? options.agent ?? current.agent, note: options.note ?? null },
    ],
  };
  writeTaskLive(state, next);
  return next;
}

/**
 * 状态转换的唯一入口：校验 + 追加 history + 原子写。
 * live 不存在时按 draft 起算（`task ready` 就是 draft → ready）。
 */
export function transitionTask(
  state: string,
  id: string,
  to: TaskStatus,
  options: TransitionOptions = {},
): TaskLive {
  const current = readTaskLive(state, id);
  if (current !== null && current.status === 'corrupt') {
    throw general(
      `任务处于 corrupt 状态，拒绝继续操作: ${id}`,
      '先用 cowork doctor 查看损坏原因；确认 live 文件后删除或修复，再重试。',
    );
  }
  // corrupt 已在上面拒绝，这里只剩协议内的状态。
  const from: TaskStatus = current === null ? 'draft' : (current.status as TaskStatus);
  assertTransition(from, to, options.reason);
  const now = new Date().toISOString();
  const next: TaskLive = {
    schemaVersion: 1,
    id,
    status: to,
    lane: options.lane !== undefined ? options.lane : (current?.lane ?? null),
    lanePath: options.lanePath !== undefined ? options.lanePath : (current?.lanePath ?? null),
    agent: options.agent !== undefined ? options.agent : (current?.agent ?? null),
    spec_commit: options.specCommit !== undefined ? options.specCommit : (current?.spec_commit ?? null),
    created_at: current?.created_at ?? now,
    updated_at: now,
    blocked_reason: to === 'blocked' ? (options.reason ?? null) : null,
    verification: current?.verification ?? null,
    recovery: current?.recovery ?? null,
    history: [
      ...(current?.history ?? []),
      { at: now, from: current === null ? 'draft' : current.status, to, agent: options.agent ?? null, note: options.note ?? null },
    ],
  };
  writeTaskLive(state, next);
  return next;
}

/**
 * 回滚失败时的 fail-closed 标记：保留能读到的事实，status 置 corrupt。
 * 即使原文件读不出来也写一条最小记录，避免任务被别人重新领取。
 */
export function markCorrupt(state: string, id: string, reason: string): TaskLive {
  let current: TaskLive | null = null;
  try {
    current = readTaskLive(state, id);
  } catch {
    current = null;
  }
  const now = new Date().toISOString();
  const live: TaskLive = {
    schemaVersion: 1,
    id,
    status: 'corrupt',
    lane: current?.lane ?? null,
    lanePath: current?.lanePath ?? null,
    agent: current?.agent ?? null,
    spec_commit: current?.spec_commit ?? null,
    created_at: current?.created_at ?? now,
    updated_at: now,
    blocked_reason: reason,
    verification: current?.verification ?? null,
    recovery: current?.recovery ?? null,
    history: [
      ...(current?.history ?? []),
      { at: now, from: current?.status ?? null, to: 'corrupt', agent: null, note: reason },
    ],
  };
  writeTaskLive(state, live);
  return live;
}

export function liveStateRoot(info: RepoInfo): string {
  return stateRoot(info);
}
