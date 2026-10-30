// 验收人独立复核：不动 tools/accept-m1.mjs，用真实 CLI 复现 §12.3 / §12.4+§11 / §12.8 / §12.9。
// 用法：node probe-m1.mjs <path/to/dist/cli.js>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve(process.argv[2] ?? 'dist/cli.js');
const TMP = [];
const out = [];
const ok = (name, cond, detail = '') => out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`);

const run = (cmd, args, cwd, env = {}, shell = false) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, shell, timeout: 120_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cw = (cwd, args, agent = 'dsh') => run(process.execPath, [CLI, ...args], cwd, { COWORK_AGENT_ID: agent });
const git = (cwd, args) => run('git', args, cwd);

function newRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cowork-probe-'));
  TMP.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'p@example.com']);
  git(root, ['config', 'user.name', 'probe']);
  mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'auth', 'login.ts'), 'export const login = 1;\n');
  writeFileSync(path.join(root, 'src', 'shared', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(root, 'src', 'shared', 'y.ts'), 'export const y = 1;\n');
  writeFileSync(path.join(root, 'README.md'), '# probe\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  const r = cw(root, ['init']);
  if (r.code !== 0) throw new Error(`cowork init: ${r.out}`);
  return root;
}
function lane(root, name) {
  const r = git(root, ['worktree', 'add', `.cowork/lanes/${name}`, '-b', name]);
  if (r.code !== 0) throw new Error(`lane ${name}: ${r.out}`);
  return path.join(root, '.cowork', 'lanes', name);
}
function addReady(root, title, touches) {
  const args = ['task', 'add', '--title', title];
  for (const t of touches) args.push('--touches', t);
  const r = cw(root, args);
  const m = r.out.match(/t-[0-9a-f]{6,}/);
  if (!m) throw new Error(`task add: ${r.out}`);
  const id = m[0];
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', `spec ${id}`]);
  const ready = cw(root, ['task', 'ready', id]);
  if (ready.code !== 0) throw new Error(`task ready: ${ready.out}`);
  return id;
}
const common = (root) => git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out.trim();
function listRel(dir) {
  if (!existsSync(dir)) return [];
  const acc = [];
  const walk = (cur, rel) => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(cur, e.name), `${rel}${e.name}/`);
      else acc.push(`${rel}${e.name}`);
    }
  };
  walk(dir, '');
  return acc.sort();
}

// ── §12.3 输出必须含占用者 lane 与 agent ─────────────────────────────
{
  const root = newRepo();
  const a = lane(root, 'a');
  const b = lane(root, 'b');
  const c = cw(a, ['claim', 'src/auth/login.ts'], 'agent-a');
  const id = addReady(root, '登录改造', ['src/auth/**']);
  const n = cw(b, ['next'], 'agent-b');
  ok('§12.3 冲突时 next exit 1', n.code === 1, `实际 exit ${n.code}`);
  ok('§12.3 输出含冲突路径', n.out.includes('src/auth/login.ts'));
  ok('§12.3 输出含占用者 lane 与 agent', /lane\s*a\b/.test(n.out) && n.out.includes('agent-a'), `实际输出：\n${n.out.trim()}`);
  const liveAfter = JSON.parse(readFileSync(path.join(common(root), 'cowork', 'tasks', `${id}.json`), 'utf8'));
  ok('§12.3 冲突时未把任务领走', liveAfter.status === 'ready' && liveAfter.agent === null, `status=${liveAfter.status} agent=${liveAfter.agent}`);
  console.log(`--- §12.3 raw ---\n${n.out.trim()}`);
}

// ── §12.4 + §11 真 barrier：谁赢，输家要说出赢家 lane；无部分占位 ──────
{
  const root = newRepo();
  const a = lane(root, 'a');
  const b = lane(root, 'b');
  const id = addReady(root, '共享任务', ['src/shared/x.ts', 'src/shared/y.ts']);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cowork-barrier-'));
  TMP.push(dir);
  const racer = path.join(dir, 'racer.mjs');
  writeFileSync(
    racer,
    `import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const [barrier, ready, cli, cwd, agent] = process.argv.slice(2);
fs.writeFileSync(ready, '1');
const t0 = Date.now();
while (!fs.existsSync(barrier)) { if (Date.now() - t0 > 15000) process.exit(9); }
const r = spawnSync(process.execPath, [cli, 'next'], { cwd, encoding: 'utf8', env: { ...process.env, COWORK_AGENT_ID: agent }, windowsHide: true });
process.stdout.write(JSON.stringify({ code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }));
`,
  );
  const lanes = [
    { cwd: a, agent: 'agent-a', tag: 'a' },
    { cwd: b, agent: 'agent-b', tag: 'b' },
  ];
  const kids = lanes.map(
    (l, i) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [racer, path.join(dir, 'go'), path.join(dir, `r${i}`), CLI, l.cwd, l.agent], {
          windowsHide: true,
        });
        let buf = '';
        p.stdout.on('data', (d) => (buf += d));
        p.on('close', () => resolve({ ...l, ...JSON.parse(buf || '{"code":-1,"out":""}') }));
      }),
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !lanes.every((_, i) => existsSync(path.join(dir, `r${i}`)))) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'], { windowsHide: true });
  }
  writeFileSync(path.join(dir, 'go'), '1');
  const res = await Promise.all(kids);
  const winners = res.filter((r) => r.code === 0);
  const losers = res.filter((r) => r.code !== 0);
  ok('§12.4 并发 next 只有一个赢家', winners.length === 1, `实际：${res.map((r) => `${r.tag}=${r.code}`).join(' ')}`);
  ok('§12.4 输家 exit 2', losers.every((r) => r.code === 2), `输家码：${losers.map((r) => r.code).join(',')}`);
  const win = winners[0];
  ok(
    '§12.4 输家打印赢家 lane',
    losers.length > 0 && losers.every((r) => r.out.includes(`lane ${win.tag}`) || r.out.includes(`lane=${win.tag}`) || r.out.includes(win.tag)),
    `输家输出：\n${losers.map((r) => r.out.trim()).join('\n---\n')}`,
  );
  const state = path.join(common(root), 'cowork');
  const claims = listRel(path.join(state, 'claims'));
  const live = JSON.parse(readFileSync(path.join(state, 'tasks', `${id}.json`), 'utf8'));
  ok('§11 无部分占位：claim 数与 touches 数一致', claims.length === 2, `claim 文件 ${claims.length} 个，touches 2 个`);
  ok('§12.4 成功侧 live=claimed 且有 spec_commit', live.status === 'claimed' && !!live.spec_commit, `status=${live.status} spec_commit=${live.spec_commit}`);
  console.log(`--- §12.4 raw ---\n${res.map((r) => `${r.tag}=${r.code}: ${r.out.trim()}`).join('\n')}`);
}

// ── §12.8 lane new 成功时不写任何 live 状态 ──────────────────────────
{
  const root = newRepo();
  const state = path.join(common(root), 'cowork');
  const snap = () => ({
    tasks: listRel(path.join(state, 'tasks')).filter((f) => !f.startsWith('intents/')),
    intents: listRel(path.join(state, 'tasks', 'intents')),
    claims: listRel(path.join(state, 'claims')),
  });
  const before = snap();
  const r = cw(root, ['lane', 'new', 'ok-lane']);
  const after = snap();
  const diff = (k) => after[k].filter((f) => !before[k].includes(f));
  ok('§12.8 lane new 成功', r.code === 0, r.out.trim());
  ok(
    '§12.8 lane new 不新增 tasks/intents/claims',
    diff('tasks').length === 0 && diff('intents').length === 0 && diff('claims').length === 0,
    `新增 tasks=${diff('tasks')} intents=${diff('intents')} claims=${diff('claims')}`,
  );
}

// ── §12.9 半成品 intent 自动回滚，且 next 仍能领取 ───────────────────
{
  const root = newRepo();
  const a = lane(root, 'a');
  const b = lane(root, 'b');
  const id = addReady(root, '半截事务', ['src/shared/x.ts']);
  const state = path.join(common(root), 'cowork');
  const liveFile = path.join(state, 'tasks', `${id}.json`);
  const beforeLive = JSON.parse(readFileSync(liveFile, 'utf8'));
  const n1 = cw(a, ['next'], 'agent-a');
  if (n1.code !== 0) throw new Error(`前置 next 失败：${n1.out}`);
  const claimsDir = path.join(state, 'claims');
  const claimRecs = readdirSync(claimsDir)
    .map((f) => JSON.parse(readFileSync(path.join(claimsDir, f), 'utf8')))
    .filter((c) => String(c.note ?? '').includes(id));
  const claimIds = claimRecs.map((c) => c.id);
  ok('§12.9 前置：能造出 claim', claimIds.length > 0, `找到 ${claimIds.length} 条`);
  console.log(`--- §12.9 claim 记录 ---\n${JSON.stringify(claimRecs[0], null, 2)}`);
  const intent = {
    schemaVersion: 1,
    operation_id: `probe-pending-${Date.now()}`,
    task_id: id,
    lane: claimRecs[0].lane,
    lane_path: claimRecs[0].lanePath,
    agent: claimRecs[0].agentId,
    branch: 'a',
    prev: { ...beforeLive, status: 'ready' },
    claim_ids: claimIds,
    phase: 'pending',
    created_at: new Date().toISOString(),
  };
  const intentsDir = path.join(state, 'tasks', 'intents');
  mkdirSync(intentsDir, { recursive: true });
  const intentFile = path.join(intentsDir, `${intent.operation_id}.json`);
  writeFileSync(intentFile, JSON.stringify(intent, null, 2));
  // 只读命令（task ls / task show）不取锁，按 §5.7 恢复只发生在取锁命令里；
  // 这里只用 next 触发，并验证「先回滚 a 的占位、再领给 b」。
  const ls = cw(root, ['task', 'ls']);
  const lsLeavesIntent = existsSync(intentFile);
  const n2 = cw(b, ['next'], 'agent-b');
  const afterLive = JSON.parse(readFileSync(liveFile, 'utf8'));
  ok('§12.9 取锁命令触发回滚并重新领取（exit 0）', n2.code === 0, n2.out.trim().slice(0, 300));
  ok('§12.9 回滚后 intent 已清', !existsSync(intentFile));
  ok(
    '§12.9 旧占位已释放或被新车道接管',
    claimIds.every((id2) => {
      const f = path.join(claimsDir, `${id2}.json`);
      if (!existsSync(f)) return true;
      const rec = JSON.parse(readFileSync(f, 'utf8'));
      return rec.agentId === 'agent-b' || rec.agent === 'agent-b';
    }),
    `残留：${claimIds.filter((id2) => existsSync(path.join(claimsDir, `${id2}.json`)))}`,
  );
  ok(
    '§12.9 任务被新车道领取（agent=agent-b）',
    afterLive.status === 'claimed' && afterLive.agent === 'agent-b',
    `status=${afterLive.status} agent=${afterLive.agent}`,
  );
  console.log(`--- §12.9 观察：task ls(exit ${ls.code}) 不取锁，半成品 intent 是否仍在=${lsLeavesIntent} ---`);
}

for (const d of TMP) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    /* ignore */
  }
}
console.log('\n===== 独立复核结果 =====');
for (const line of out) console.log(line);
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
