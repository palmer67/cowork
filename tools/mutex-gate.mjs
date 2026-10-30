// M0 开工门槛:验证「建目录当锁」(mkdir mutex) 在 Windows/NTFS 上是否真的互斥。
//
// 只验证这一件事,不验证业务逻辑。判定标准(任一不满足即整个设计作废):
//   1. N 个独立进程各竞争 ITERS 次,重叠进入次数必须为 0
//   2. 每个进程的获取次数必须等于 ITERS(不许静默失败)
//   3. 子进程错误/超时必须为 0
//   4. 结束后残留锁目录必须为 0
//
// 重叠检测用一个独立的原子探针(sentinel),不依赖锁本身:拿到 mkdir 锁后,
// 以 O_EXCL 创建 sentinel 文件。若 sentinel 已存在,说明锁没挡住,发生重叠。
//
// 用法:node tools/mutex-gate.mjs [--procs 8] [--iters 1000]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const isChild = process.argv.includes('--child');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}

const spinUntil = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* busy wait: 亚毫秒级退避,不引入定时器开销 */ }
};

// ---------------------------------------------------------------- 子进程
async function child() {
  const dir = process.argv[process.argv.indexOf('--dir') + 1];
  const iters = arg('iters', 1000);
  const hold = arg('hold', 1); // 临界区时长上限(ms),用来模拟真实 claim 的持锁时间
  const barrier = path.join(dir, 'barrier');
  const lockPath = path.join(dir, 'lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const sentinel = path.join(dir, 'sentinel');

  // 等父进程放行,保证 N 个进程真正同时起跑
  while (!fs.existsSync(barrier)) spinUntil(1);

  let acquired = 0;
  let overlaps = 0;
  let errors = 0;
  let timeouts = 0;
  let maxWaitMs = 0;

  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    let got = false;
    let waited = 0;
    while (!got) {
      try {
        fs.mkdirSync(lockPath);
        got = true;
      } catch (e) {
        if (e.code === 'EEXIST') {
          if (waited > 30000) { timeouts++; break; }   // 死锁兜底,任何一次触发都算失败
          waited += 1;
          spinUntil(Math.random() * 2);
        } else if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') {
          // 杀毒/索引器的短暂占用:有界重试
          if (waited > 5000) { errors++; break; }
          waited += 1;
          spinUntil(1);
        } else {
          errors++;
          break;
        }
      }
    }
    if (!got) continue;
    maxWaitMs = Math.max(maxWaitMs, performance.now() - t0);

    // 持锁:写 owner,再用独立探针确认没有第二个人进来
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      let overlap = false;
      try {
        fs.closeSync(fs.openSync(sentinel, 'wx'));
      } catch (e) {
        if (e.code === 'EEXIST') { overlaps++; overlap = true; }
        else throw e;
      }
      if (overlap) { try { fs.unlinkSync(sentinel); } catch {} }
      spinUntil(Math.random() * hold);
      try { fs.unlinkSync(sentinel); } catch {}
    } finally {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    }
    acquired++;
  }

  process.stdout.write(JSON.stringify({ pid: process.pid, acquired, overlaps, errors, timeouts, maxWaitMs }) + '\n');
}

// ---------------------------------------------------------------- 父进程
async function parent() {
  const procs = arg('procs', 8);
  const iters = arg('iters', 1000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-gate-'));
  fs.writeFileSync(path.join(dir, 'probe'), 'ok'); // 先确认目录可写

  const kids = [];
  const results = [];
  let pending = procs;

  const done = new Promise((resolve) => {
    for (let i = 0; i < procs; i++) {
      const cp = spawn(process.execPath, [self, '--child', '--dir', dir, '--iters', String(iters), '--hold', String(arg('hold',1))], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let buf = '';
      cp.stdout.on('data', (d) => { buf += d; });
      cp.stderr.on('data', (d) => { process.stderr.write(`[child ${i}] ${d}`); });
      cp.on('close', (code) => {
        for (const line of buf.split('\n').filter(Boolean)) {
          try { results.push(JSON.parse(line)); } catch { /* 忽略非 JSON 行 */ }
        }
        if (code !== 0) results.push({ pid: -1, crashExit: code });
        if (--pending === 0) resolve();
      });
      kids.push(cp);
    }
  });

  spinUntil(Number(process.env.GATE_START_DELAY_MS || 800));
  fs.writeFileSync(path.join(dir, 'barrier'), 'go');
  const t0 = performance.now();
  await done;
  const elapsed = performance.now() - t0;

  const residual = fs.existsSync(path.join(dir, 'lock'));
  const sum = (k) => results.reduce((a, r) => a + (r[k] || 0), 0);
  const crashes = results.filter((r) => r.crashExit !== undefined).length;
  const short = results.filter((r) => r.acquired !== iters).length;

  const report = {
    procs, iters, runs: procs * iters,
    overlaps: sum('overlaps'),
    crashes,
    errors: sum('errors'),
    timeouts: sum('timeouts'),
    incompleteProcs: short,
    residualLock: residual,
    elapsedMs: Math.round(elapsed),
    maxWaitMs: Math.round(Math.max(0, ...results.map((r) => r.maxWaitMs || 0))),
    dir,
  };
  report.pass =
    report.overlaps === 0 && crashes === 0 && report.errors === 0 &&
    report.timeouts === 0 && short === 0 && !residual;

  console.log(JSON.stringify(report, null, 2));
  if (report.pass) {
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    console.log(`\n现场保留在 ${dir} 供排查。`);
  }
  process.exit(report.pass ? 0 : 1);
}

if (isChild) await child();
else await parent();
