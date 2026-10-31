// 并发回归循环：反复跑 5 进程 barrier 的 next 用例，默认 50 次。
// 用法：node tools/loop-concurrency.mjs [次数]
import { spawnSync } from 'node:child_process';

const runs = Number(process.argv[2] ?? 50);
if (!Number.isInteger(runs) || runs < 1) {
  console.error('usage: node tools/loop-concurrency.mjs [runs>=1]');
  process.exit(3);
}

let failed = 0;
for (let i = 1; i <= runs; i += 1) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', 'test/tasknext-concurrency.test.ts'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const elapsed = Date.now() - started;
  const status = result.status ?? 1;
  if (status !== 0) {
    failed += 1;
    console.log(`RUN${i}=${status} (${elapsed}ms) FAIL`);
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-25);
    for (const line of detail) console.log(`  ${line}`);
  } else {
    console.log(`RUN${i}=0 (${elapsed}ms)`);
  }
}

console.log(failed === 0 ? `全部 ${runs} 次通过` : `${failed}/${runs} 次失败`);
process.exit(failed === 0 ? 0 : 1);
