import { hostname } from 'node:os';
import { busy } from './errors.ts';
import { currentBranch, type RepoInfo } from './git.ts';
import { withLock } from './mutex.ts';
import { conflicts, formatClaim, parseClaim, type ClaimPath } from './paths.ts';
import {
  asClaimPath,
  claimFilePath,
  ensureState,
  listClaimIds,
  listClaims,
  quarantineClaim,
  readClaim,
  removeClaim,
  stateRoot,
  uniqueClaimId,
  writeClaim,
  type ClaimRecord,
} from './store.ts';

export interface ClaimOptions {
  note?: string | undefined;
  timeoutMs?: number | undefined;
  onWait?: ((owner: unknown) => void) | undefined;
}

export interface ClaimResult {
  claimed: ClaimRecord[];
  refreshed: ClaimRecord[];
  pruned: ClaimRecord[];
}

const DEFAULT_TTL_HOURS = 24;

/**
 * 占位存活时长。CLI 每次调用都是新进程，pid 不能用来判断"agent 还在不在"，
 * 所以有效性只由 TTL 决定；崩溃留下的占位最多存活 TTL 这么久。
 */
export function claimTtlMs(): number {
  const raw = process.env['COWORK_CLAIM_TTL_HOURS'];
  const hours = raw === undefined ? DEFAULT_TTL_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_TTL_HOURS * 3_600_000;
  return Math.round(hours * 3_600_000);
}

/** 调用方身份：两个 agent 共用一个工作树时，靠它区分"是不是我自己"。 */
export function agentId(): string {
  const raw = process.env['COWORK_AGENT_ID'];
  return raw === undefined || raw.trim() === '' ? 'default' : raw.trim();
}

export function expiresAt(rec: ClaimRecord): string {
  const ttl = Number.isFinite(rec.ttlMs) && rec.ttlMs > 0 ? rec.ttlMs : DEFAULT_TTL_HOURS * 3_600_000;
  return new Date(Date.parse(rec.createdAt) + ttl).toISOString();
}

export function isExpired(rec: ClaimRecord, now: number = Date.now()): boolean {
  const start = Date.parse(rec.createdAt);
  if (!Number.isFinite(start)) return false;
  const ttl = Number.isFinite(rec.ttlMs) && rec.ttlMs > 0 ? rec.ttlMs : DEFAULT_TTL_HOURS * 3_600_000;
  return start + ttl <= now;
}

function sameOwner(rec: ClaimRecord, lanePath: string, owner: string): boolean {
  return rec.lanePath === lanePath && rec.agentId === owner;
}

function describeOwner(rec: ClaimRecord): string {
  const where = rec.lane === null ? rec.lanePath : `lane ${rec.lane}`;
  const who = rec.agentId === 'default' ? '' : ` agent=${rec.agentId}`;
  return `${where}${who} 的 pid ${rec.pid}@${rec.host}`;
}

/**
 * 取占位。多个路径是一个事务：先全部校验，再统一写入，任一冲突则整单失败，
 * 不会留下半份占位。过期的占位在加锁后顺手回收。
 */
export async function claim(
  info: RepoInfo,
  inputs: readonly string[],
  options: ClaimOptions = {},
): Promise<ClaimResult> {
  if (inputs.length === 0) {
    throw busy('没有指定任何路径', '用法: cowork claim <文件或目录前缀>...');
  }
  const wanted = inputs.map((raw) => parseClaim(raw, info));
  const state = stateRoot(info);
  ensureState(state);
  const branch = currentBranch(info.laneTop);
  const host = hostname();
  const owner = agentId();
  const ttlMs = claimTtlMs();

  return withLock(
    state,
    () => {
      const now = Date.now();
      const pruned: ClaimRecord[] = [];
      const live: ClaimRecord[] = [];
      for (const rec of listClaims(state)) {
        if (isExpired(rec, now)) {
          removeClaim(state, rec.id);
          pruned.push(rec);
        } else {
          live.push(rec);
        }
      }

      // 第一遍：只校验，不写任何东西。
      const toCreate: ClaimPath[] = [];
      const refreshed: ClaimRecord[] = [];
      for (const want of wanted) {
        const own = live.find(
          (rec) => sameOwner(rec, info.laneTop, owner) && rec.kind === want.kind && rec.key === want.key,
        );
        if (own !== undefined) {
          refreshed.push(own);
          continue;
        }
        const clash = live.find(
          (rec) => !sameOwner(rec, info.laneTop, owner) && conflicts(want, asClaimPath(rec)),
        );
        if (clash !== undefined) {
          throw busy(
            `路径已被占用: ${formatClaim(want)} ← ${describeOwner(clash)}，于 ${clash.createdAt}`,
            `先运行 cowork status 看全部占位；等对方 cowork release，或换一条不冲突的路径。万一对方已经崩溃，由人来运行 cowork release --force ${formatClaim(want)}（会打印原占用者）。cowork 不给 claim --force：抢占会让两个 agent 同时改同一个文件。`,
          );
        }
        toCreate.push(want);
      }

      // 第二遍：全部校验通过后才写入。
      const claimed: ClaimRecord[] = [];
      const createdAt = new Date().toISOString();
      for (const want of toCreate) {
        const record: ClaimRecord = {
          id: uniqueClaimId(want),
          kind: want.kind,
          key: want.key,
          display: formatClaim(want),
          lane: info.laneName,
          lanePath: info.laneTop,
          branch,
          agentId: owner,
          pid: process.pid,
          host,
          note: options.note ?? null,
          createdAt,
          ttlMs,
        };
        writeClaim(state, record);
        claimed.push(record);
      }
      for (const rec of refreshed) writeClaim(state, { ...rec, createdAt });
      return { claimed, refreshed, pruned };
    },
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onWait: (lockOwner) => {
        options.onWait?.(lockOwner);
      },
    },
  );
}

export interface ReleaseResult {
  released: ClaimRecord[];
}

export interface ReleaseOptions {
  /** 由人强拆别人的占位（对方已崩溃时）。会打印原占用者。 */
  force?: boolean | undefined;
}

/** 不指定路径时释放本工作树（本 agent）的全部占位。 */
export async function release(
  info: RepoInfo,
  inputs: readonly string[],
  options: ReleaseOptions = {},
): Promise<ReleaseResult> {
  const state = stateRoot(info);
  ensureState(state);
  const wanted: ClaimPath[] | null =
    inputs.length === 0 ? null : inputs.map((raw) => parseClaim(raw, info));
  const owner = agentId();
  const force = options.force === true;

  return withLock(state, () => {
    const released: ClaimRecord[] = [];
    for (const rec of listClaims(state)) {
      if (!force && !sameOwner(rec, info.laneTop, owner)) continue;
      if (wanted !== null) {
        const match = wanted.some((w) => w.kind === rec.kind && w.key === rec.key);
        if (!match) continue;
      }
      if (removeClaim(state, rec.id)) released.push(rec);
    }
    return { released };
  });
}

export interface StatusReport {
  state: string;
  mainRoot: string;
  laneTop: string;
  lane: string | null;
  agent: string;
  claims: ClaimRecord[];
  expired: ClaimRecord[];
}

export async function status(info: RepoInfo): Promise<StatusReport> {
  const state = stateRoot(info);
  ensureState(state);
  return withLock(state, () => {
    const claims = listClaims(state);
    const now = Date.now();
    return {
      state,
      mainRoot: info.mainRoot,
      laneTop: info.laneTop,
      lane: info.laneName,
      agent: agentId(),
      claims,
      expired: claims.filter((rec) => isExpired(rec, now)),
    };
  });
}

export interface QuarantinedClaim {
  /** 原来的 claim 文件路径。 */
  path: string;
  /** 移到 trash 后的路径；移动失败为 null。 */
  trash: string | null;
  reason: string;
}

export interface DoctorReport {
  /** 过期并已回收的占位。 */
  pruned: ClaimRecord[];
  /** 损坏并被隔离的状态文件。 */
  quarantined: QuarantinedClaim[];
}

/**
 * 回收过期占位，隔离损坏的状态文件。坏文件不能静默跳过：
 * 跳过等于把"读不到"伪装成"没有占位"，两个 agent 会同时改一个文件。
 */
export async function doctorFix(info: RepoInfo): Promise<DoctorReport> {
  const state = stateRoot(info);
  ensureState(state);
  return withLock(state, () => {
    const pruned: ClaimRecord[] = [];
    const quarantined: QuarantinedClaim[] = [];
    const now = Date.now();
    for (const id of listClaimIds(state)) {
      const path = claimFilePath(state, id);
      try {
        const rec = readClaim(state, id);
        if (rec !== null && isExpired(rec, now) && removeClaim(state, rec.id)) pruned.push(rec);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        quarantined.push({ path, trash: quarantineClaim(state, id), reason });
      }
    }
    return { pruned, quarantined };
  });
}
