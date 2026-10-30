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

export function readClaim(state: string, id: string): ClaimRecord | null {
  const file = claimFile(state, id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ClaimRecord;
  } catch {
    return null;
  }
}

export function writeClaim(state: string, record: ClaimRecord): void {
  const file = claimFile(state, record.id);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function removeClaim(state: string, id: string): boolean {
  const file = claimFile(state, id);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export function listClaims(state: string): ClaimRecord[] {
  const dir = claimsDir(state);
  if (!existsSync(dir)) return [];
  const out: ClaimRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const rec = readClaim(state, name.slice(0, -'.json'.length));
    if (rec !== null) out.push(rec);
  }
  out.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  return out;
}

export function asClaimPath(record: ClaimRecord): ClaimPath {
  return { kind: record.kind, key: record.key, display: record.display };
}
