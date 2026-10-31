import { conflicts, parseClaim } from './paths.ts';
import type { RepoInfo } from './git.ts';
import type { HandoffMeta } from './handoffs.ts';

export interface ContractTask {
  id: string;
  status: string;
  reads: readonly string[];
  touches: readonly string[];
  assigned_lane: string | null;
}

export interface ContractAlert {
  kind: 'reads_touches' | 'reads_contract' | 'touches_contract';
  task: string;
  path: string;
  peer_task: string | null;
  peer_lane: string | null;
  handoff_path: string | null;
  summary: string;
}

const ACTIVE_STATUSES = new Set(['ready', 'claimed', 'in_progress', 'reported_done', 'verifying', 'verify_failed', 'awaiting_merge', 'blocked']);

export function buildContractAlerts(
  info: RepoInfo,
  tasks: readonly ContractTask[],
  handoffs: readonly HandoffMeta[],
): ContractAlert[] {
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const alerts = new Map<string, ContractAlert>();
  const claimOf = (raw: string) => {
    try { return parseClaim(raw, info); } catch { return null; }
  };
  const add = (alert: ContractAlert): void => {
    const key = JSON.stringify([alert.kind, alert.task, alert.path, alert.peer_task, alert.peer_lane, alert.handoff_path]);
    if (!alerts.has(key)) alerts.set(key, alert);
  };

  for (const reader of active) {
    for (const readRaw of reader.reads) {
      const read = claimOf(readRaw);
      if (read === null) continue;
      for (const writer of active) {
        if (writer.id === reader.id) continue;
        for (const touchRaw of writer.touches) {
          const touch = claimOf(touchRaw);
          if (touch !== null && conflicts(read, touch)) {
            add({
              kind: 'reads_touches', task: reader.id, path: read.display,
              peer_task: writer.id, peer_lane: writer.assigned_lane,
              handoff_path: null,
              summary: `${reader.id} reads 与 ${writer.id} touches 相交`,
            });
          }
        }
      }
      for (const handoff of handoffs) {
        for (const change of handoff.contracts_changed) {
          for (const changedRaw of change.paths) {
            const changed = claimOf(changedRaw);
            if (changed !== null && conflicts(read, changed)) {
              add({
                kind: 'reads_contract', task: reader.id, path: changed.display,
                peer_task: handoff.task_id, peer_lane: handoff.lane,
                handoff_path: handoff.path,
                summary: `${change.old} → ${change.new}；兼容性：${change.compatibility}${change.affected_tasks.length ? `；受影响任务：${change.affected_tasks.join(', ')}` : ''}`,
              });
            }
          }
        }
      }
    }
  }

  for (const writer of active) {
    for (const touchRaw of writer.touches) {
      const touch = claimOf(touchRaw);
      if (touch === null) continue;
      for (const handoff of handoffs) {
        for (const change of handoff.contracts_changed) {
          for (const changedRaw of change.paths) {
            const changed = claimOf(changedRaw);
            if (changed !== null && conflicts(touch, changed)) {
              add({
                kind: 'touches_contract', task: writer.id, path: changed.display,
                peer_task: handoff.task_id, peer_lane: handoff.lane,
                handoff_path: handoff.path,
                summary: `${change.old} → ${change.new}；兼容性：${change.compatibility}${change.affected_tasks.length ? `；受影响任务：${change.affected_tasks.join(', ')}` : ''}`,
              });
            }
          }
        }
      }
    }
  }

  return [...alerts.values()];
}
