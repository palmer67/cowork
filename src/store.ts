import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { general, pathError } from './errors.ts';
import type { RepoInfo } from './git.ts';
import type { ClaimKind, ClaimPath } from './paths.ts';

export interface ClaimRecord {
  id: string;
  kind: ClaimKind;
  key: string;
  /** 展示用：按 kind 格式化后的路径（prefix 带 /**）。 */
  display: string;
  lane: string | null;
  lanePath: string;
  branch: string | null;
  /** 调用方身份，来自 COWORK_AGENT_ID；同一车道内区分不同 agent 的唯一依据。 */
  agentId: string;
  pid: number;
  host: string;
  note: string | null;
  createdAt: string;
  /** 存活时长；过期后任何命令都可以回收，避免崩溃的 agent 永久占位。 */
  ttlMs: number;
}

/** live 状态根：<git-common-dir>/cowork，跨 worktree 天然共享，永不入库。 */
export function stateRoot(info: RepoInfo): string {
  return path.join(info.commonDir, 'cowork');
}

export function claimsDir(state: string): string {
  return path.join(state, 'claims');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 读一个 live 状态目录。目录不存在 = 合法空集（还没人占位）；
 * 存在但读不出来（ACL、坏 junction、路径被文件占着）必须 fail closed——
 * 把读不出的占位当成"没有占位"会让 next 放行一个已经被占用的路径。
 */
export function readStateDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    const tooLong = pathError(err, dir);
    if (tooLong !== null) throw tooLong;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw general(
      `任务状态不可读: ${dir}（${message(err)}）`,
      '读不出占位/任务状态时不能把空集当成"没有占位或没有任务"；检查 .git/cowork 的权限或 junction 指向，修好后重试。',
    );
  }
}

export function ensureState(state: string): void {
  mkdirSync(claimsDir(state), { recursive: true });
  mkdirSync(path.join(state, 'trash'), { recursive: true });
}

let idCounter = 0;

export function claimId(p: ClaimPath): string {
  return createHash('sha1').update(`${p.kind}:${p.key}`).digest('hex').slice(0, 16);
}

/** 用于测试与同 key 不同进程的区分。 */
export function uniqueClaimId(p: ClaimPath): string {
  idCounter += 1;
  return `${claimId(p)}-${idCounter}`;
}

function claimFile(state: string, id: string): string {
  return path.join(claimsDir(state), `${id}.json`);
}

/** claim 文件的绝对路径，供 doctor 报告隔离结果。 */
export function claimFilePath(state: string, id: string): string {
  return claimFile(state, id);
}

const CLAIM_KINDS: readonly string[] = ['file', 'prefix'];

/**
 * 运行时校验：状态文件是跨进程、跨 agent 的共享真相，坏字段不能当默认值读。
 * pid/agent/host 会被渲染到面板里，类型不对就按损坏处理。
 */
function asClaimRecord(raw: unknown, file: string): ClaimRecord {
  const corrupt = (detail: string): never => {
    throw general(
      `状态文件损坏: ${file}（${detail}）`,
      '运行 cowork doctor --fix 隔离损坏文件；再运行 cowork status 确认占位状态。',
    );
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) corrupt('不是 JSON 对象');
  const rec = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = rec[key];
    if (typeof value !== 'string') corrupt(`${key} 不是字符串`);
    return value as string;
  };
  const nullableStr = (key: string): string | null => {
    const value = rec[key];
    if (value === null) return null;
    if (typeof value !== 'string') corrupt(`${key} 不是字符串或 null`);
    return value as string;
  };
  const id = str('id');
  const kind = str('kind');
  if (!CLAIM_KINDS.includes(kind)) corrupt(`kind 不是 file/prefix: ${kind}`);
  const pid = rec['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid)) corrupt('pid 不是整数');
  const ttlMs = rec['ttlMs'];
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) corrupt('ttlMs 不是数字');
  return {
    id,
    kind: kind as ClaimKind,
    key: str('key'),
    display: str('display'),
    lane: nullableStr('lane'),
    lanePath: str('lanePath'),
    branch: nullableStr('branch'),
    agentId: str('agentId'),
    pid: pid as number,
    host: str('host'),
    note: nullableStr('note'),
    createdAt: str('createdAt'),
    ttlMs: ttlMs as number,
  };
}

export function readClaim(state: string, id: string): ClaimRecord | null {
  const file = claimFile(state, id);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw general(
      `状态文件损坏: ${file}（${err instanceof Error ? err.message : String(err)}）`,
      '运行 cowork doctor --fix 隔离损坏文件；再运行 cowork status 确认占位状态。',
    );
  }
  return asClaimRecord(raw, file);
}

export function writeClaim(state: string, record: ClaimRecord): void {
  const file = claimFile(state, record.id);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 保留原始路径错误。 */ }
    throw pathError(err, file) ?? err;
  }
}

export function removeClaim(state: string, id: string): boolean {
  const file = claimFile(state, id);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** claims 目录里登记的所有 id（不解析内容），doctor 用它逐条隔离坏文件。 */
export function listClaimIds(state: string): string[] {
  const dir = claimsDir(state);
  return readStateDir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/** 把损坏的 claim 文件移到 trash；返回新的路径，移动失败返回 null。 */
export function quarantineClaim(state: string, id: string): string | null {
  const file = claimFile(state, id);
  if (!existsSync(file)) return null;
  const trash = path.join(state, 'trash');
  mkdirSync(trash, { recursive: true });
  const target = path.join(trash, `claim-${id}-${Date.now()}.json`);
  try {
    renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

export function listClaims(state: string): ClaimRecord[] {
  const out: ClaimRecord[] = [];
  for (const name of readStateDir(claimsDir(state))) {
    if (!name.endsWith('.json')) continue;
    // 坏文件不跳过：读不出来就抛错，让人先 doctor --fix，别把占位当不存在。
    const rec = readClaim(state, name.slice(0, -'.json'.length));
    if (rec !== null) out.push(rec);
  }
  out.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  return out;
}

export function asClaimPath(record: ClaimRecord): ClaimPath {
  return { kind: record.kind, key: record.key, display: record.display };
}
