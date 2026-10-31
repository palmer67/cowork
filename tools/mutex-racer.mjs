// 并发抢锁的 racer：反复读-改-写 counter 文件，只有互斥成立时最终计数才等于总次数。
// 用法：node --experimental-strip-types tools/mutex-racer.mjs <stateRoot> <counterFile> <rounds>
import { readFileSync, writeFileSync } from 'node:fs';
import { withLock } from '../src/mutex.ts';

const [, , stateRoot, counterFile, roundsRaw] = process.argv;
const rounds = Number(roundsRaw);
if (!stateRoot || !counterFile || !Number.isInteger(rounds) || rounds < 1) {
  console.error('usage: mutex-racer.mjs <stateRoot> <counterFile> <rounds>');
  process.exit(3);
}

for (let i = 0; i < rounds; i += 1) {
  await withLock(
    stateRoot,
    async () => {
      const value = Number(readFileSync(counterFile, 'utf8'));
      // 让临界区跨过 tick，放大读-改-写之间的窗口。
      await new Promise((resolve) => setTimeout(resolve, 1));
      writeFileSync(counterFile, String(value + 1), 'utf8');
    },
    { timeoutMs: 60_000 },
  );
}
