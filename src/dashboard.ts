import path from 'node:path';
import { agentId } from './claims.ts';
import { gitTry, type RepoInfo } from './git.ts';
import { snapshot, type SnapshotLane, type SnapshotTask, type Snapshot } from './snapshot.ts';
import { readStateDir, stateRoot } from './store.ts';
import { listTaskLiveStates } from './taskstore.ts';
import { intentsDir } from './tasknext.ts';
import { TASK_STATUSES } from './tasks.ts';

interface Hint {
  kind: 'reported_done' | 'spec_drift' | 'intent' | 'artifacts' | 'diagnostics';
  count: number;
  command: string;
  detail: string;
}

export interface Dashboard {
  schemaVersion: 1;
  generatedAt: string;
  repo: Snapshot['repo'];
  this: { lane: string | null; path: string; agent: string };
  lanes: (SnapshotLane & { behind_trunk: boolean | null })[];
  claims: Snapshot['claims'];
  tasks: { counts: Record<string, number>; items: SnapshotTask[] };
  hints: Hint[];
}

const ACTIVE = new Set(['ready', 'claimed', 'in_progress', 'reported_done', 'verifying', 'verify_failed', 'awaiting_merge', 'blocked']);

/** 只读组合快照：任何目录不存在都视为空，不创建目录、不恢复 intent。 */
export async function dashboard(info: RepoInfo): Promise<Dashboard> {
  const snap = await snapshot(info);
  const state = stateRoot(info);
  const trunkHead = gitTry(['rev-parse', '--verify', `${snap.repo.trunk ?? 'main'}^{commit}`], info.mainRoot);
  const lanes = snap.lanes.map((item) => {
    const missing = item.head === null || trunkHead === null ? null :
      gitTry(['rev-list', '--count', `${item.head}..${trunkHead}`], info.mainRoot);
    return { ...item, behind_trunk: missing === null ? null : Number(missing) > 0 };
  });
  const counts: Record<string, number> = Object.fromEntries(TASK_STATUSES.map((item) => [item, 0]));
  for (const task of snap.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const lives = listTaskLiveStates(state).lives;
  const overdue = lives.filter((live) => {
    if (live.status !== 'reported_done') return false;
    const report = [...live.history].reverse().find((entry) => entry.to === 'reported_done');
    return Date.now() - Date.parse(report?.at ?? live.updated_at) > 24 * 60 * 60 * 1000;
  });
  let drift = 0;
  for (const task of snap.tasks) {
    if (task.spec_commit === null || !ACTIVE.has(task.status)) continue;
    const rel = `.cowork/tasks/${task.id}.md`;
    const before = gitTry(['rev-parse', '--verify', `${task.spec_commit}:${rel}`], info.mainRoot);
    const current = trunkHead === null ? null : gitTry(['rev-parse', '--verify', `${trunkHead}:${rel}`], info.mainRoot);
    if (before === null || current === null || before !== current) drift += 1;
  }
  const intents = readStateDir(intentsDir(state)).filter((name) => name.endsWith('.json')).length;
  const lockTmp = readStateDir(state).filter((name) => name.startsWith('lock.tmp-')).length;
  const trash = readStateDir(path.join(state, 'trash')).length;
  const hints: Hint[] = [
    { kind: 'reported_done', count: overdue.length, command: overdue.length > 0 ? `cowork task done ${overdue[0]!.id}` : 'cowork task ls --status reported_done', detail: 'reported_done 超过 24h 未验证' },
    { kind: 'spec_drift', count: drift, command: 'cowork doctor', detail: 'spec_commit 内容漂移（先检查，再 cancel/ready）' },
    { kind: 'intent', count: intents, command: 'cowork doctor --fix', detail: '残留 intent' },
    { kind: 'artifacts', count: lockTmp + trash, command: 'cowork doctor --fix', detail: `lock.tmp-* ${lockTmp} / trash/ ${trash}（doctor 按年龄清理）` },
  ];
  const errors = [
    ...snap.task_diagnostics,
    ...lanes.flatMap((item) => item.error === undefined ? [] : [item.error]),
  ];
  if (errors.length > 0) hints.push({ kind: 'diagnostics', count: errors.length, command: 'cowork snapshot --json', detail: errors[0]! });
  return {
    schemaVersion: 1, generatedAt: snap.generatedAt, repo: snap.repo,
    this: { lane: info.laneName, path: info.laneTop, agent: agentId() },
    lanes, claims: snap.claims, tasks: { counts, items: snap.tasks }, hints,
  };
}

/** 防止用户标题/路径/摘要中的换行突破仪表盘的 40 行预算。 */
function line(value: string): string { return value.replace(/[\r\n\u2028\u2029]/g, ' '); }
function summary(value: string): string { return [...line(value)].slice(0, 60).join(''); }

function section(title: string, rows: string[], limit: number): string[] {
  return [title, ...(rows.length === 0 ? ['  无'] : rows.slice(0, limit).map((item) => `  ${line(item)}`)),
    ...(rows.length > limit ? [`  … 另 ${rows.length - limit} 条（完整内容: cowork status --json）`] : [])];
}

/** 行预算上限 38；JSON 保留全部条目。 */
export function renderDashboard(report: Dashboard): string {
  const special = report.tasks.items.filter((task) => ['verifying', 'verify_failed', 'awaiting_merge'].includes(task.status));
  const rows = special.map((task) => {
    const verification = task.verification;
    const detail = task.status === 'verify_failed' ? summary(verification?.summary ?? '验证失败，运行 task show 查看') :
      summary(`run_id=${verification?.run_id ?? '(无)'} ${task.title}`);
    return `${task.id} ${task.status} lane=${task.assigned_lane ?? '(主)'} ${detail}`;
  });
  return [
    `仓库: ${line(report.repo.root)}  trunk=${line(report.repo.trunk ?? 'main')}`,
    `本工作树: ${line(report.this.lane ?? '(主工作树)')}  agent=${line(report.this.agent)}`,
    ...section('车道', report.lanes.map((item) => `${item.lane ?? '(主)'} ${item.branch ?? '(detached)'}@${item.head ?? '?'} 未提交=${item.changed_file_count ?? '?'} ${item.behind_trunk === null ? 'trunk未知' : item.behind_trunk ? '落后trunk' : '未落后trunk'}${item.error === undefined ? '' : ` ! ${summary(item.error)}`}`), 6),
    ...section('占位', report.claims.map((item) => `${item.path} [${item.kind}] lane=${item.lane ?? '(主)'} ${item.agent} pid=${item.pid}@${item.host} 过期=${item.expiresAt}${item.expired ? '（已过期，cowork doctor --fix）' : ''}`), 6),
    '任务',
    `  ${['ready', 'claimed', 'in_progress', 'reported_done'].map((key) => `${key}=${report.tasks.counts[key] ?? 0}`).join(' / ')}`,
    `  ${['verifying', 'verify_failed', 'awaiting_merge', 'merged'].map((key) => `${key}=${report.tasks.counts[key] ?? 0}`).join(' / ')}`,
    `  ${['draft', 'blocked', 'cancelled', 'corrupt'].map((key) => `${key}=${report.tasks.counts[key] ?? 0}`).join(' / ')}`,
    ...section('  验证 / 待合并明细', rows, 8),
    ...section('提示', report.hints.map((hint) => `${hint.detail}: ${hint.count}；${hint.command}`), 5),
  ].join('\n');
}
