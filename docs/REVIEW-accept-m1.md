# 评审：`tools/accept-m1.mjs` 对照 `docs/WORKORDER-M1.md` §12

> 评审人：dsh-review 车道。对象：`tools/accept-m1.mjs`（`bc2e776`，357 行）。
> 判据：工作令 §12 十条 + §11 门槛。只看「脚本能否独立证明这一条」，不评价实现。

## 结论

骨架是对的（每条独立临时仓库、`assertImplemented()` 挡住「未知命令 → exit 1 → 伪装通过」、
清理 `maxRetries: 20/retryDelay: 200` 与 §11 一致）。但 **10 条里有 4 条不等价于 §12**，
1 条默认被 SKIP，等于门槛没验。建议在跑验收前让小东补掉 A–E，否则我跑出来的绿不作数。

## 缺口

### A. §12.3 的「占用者 agent」断言恒真

```
$ sed -n '174,178p' tools/accept-m1.mjs
  const n = cw(b, ['next'], 'b');
  check(n.code === 1, ...);
  check(n.out.includes('src/auth/login.ts'), '输出里没有冲突路径');
  check(n.out.includes('a'), '输出里没有占用者车道');
```

`includes('a')` 是**单字符**包含判断，任何含 `a` 的输出都通过（连 `error`、`lane`、`agent` 都含 a）。
§12.3 要求输出含「车道 A 的 **agent**」。断言实际为零。
→ 改成结构化断言：`/lane\s*a\b/` 或 `agent=a`，并断言消息里出现 claim 语义（不是「没有任务」）。

### B. §12.4 少了「打印赢家 lane」，也没有真 barrier

§12.4 要求「一个 exit 0，另一个 exit 2 **且打印赢家 lane**」。脚本只比退出码（`201-214`
的 `observations` 与 `0,2` 判断），从不看失败侧的输出；而且脚本自己在失败文案里承认
「可能是进程没真正重叠」——因为两个 `spawn` 只是 `Promise.all` 起，没有同步点。
→ 三件事：(1) 加 barrier 文件：每个进程就位后写入，等全部就位再 `next`；
(2) 断言 exit 2 那侧的输出含胜者 lane 与 task id；
(3) 顺手断言 §11 的「没有部分占位」——成功侧 live 的 touches 数 == 实际 claim 数。

### C. §12.8 的「`lane new` 不产生任何 live 写入」完全没测

脚本第 8 条只测了名字校验、重名 `2`、`--task` 已移除（`286-300`）。
§12.8 最后一句「成功后 `lane new` 不产生任何 live 写入」是这条的验收重点（评审 I3/I4 的落点），
一条断言都没有。
→ 在建 lane 前后对 `<common>/cowork/{tasks,claims,intents}` 各做一次文件清单快照，
断言无新增（注意排除 mutex 目录的短暂存在——那不算 live 写入）。

### D. 第 9 条验的是 §9 的要求，不是 §12.9

```
$ sed -n '310,315p' tools/accept-m1.mjs
  writeFileSync(path.join(liveTasks, 't-ffffff.json'), '{"id":"t-ffffff","status":');
  const doc = cw(root, ['doctor']);
  check(doc.code === 1, ...);
  const n = cw(root, ['next']);
  check(n.code !== 0, ...);
```

造的是**损坏的 live task JSON**，验的是「doctor 不静默 exit 0 / next fail closed」——这是
工作令 §9 的要求。而 §12.9 要的是「手工写一个**半成品 intent** → 任意命令自动回滚，
`next` 仍能正常领取」。
→ 两条都要留：把现第 9 条改名为「§9 损坏 live 不伪装成空」（它就是那个已知必红的项），
**新增**一条「§12.9 半成品 intent 回滚后仍可领取」：写 intents/<opid>.json（phase=pending、
claim_ids 指向真 claim、prev 指向原 live），跑任意命令，断言 (a) intent 被清掉、
(b) live 回到 ready、(c) 紧接着的 `next` exit 0。
注意：这一语义已有单测（`test/tasknext.test.ts:213`），但 §12 是验收依据，脚本要能独立证明。

### E. §12.10 默认 SKIP

```
$ sed -n '319,321p' tools/accept-m1.mjs
def(10, 'npm test ≥60 且 tsc 干净（需 --with-build）', () => {
  if (!has('--with-build')) return ['跳过：未加 --with-build'];
```

而约定的验收命令是 `npm run build && node tools/accept-m1.mjs`（不带 `--with-build`），
于是「≥60 且 tsc 干净」这条门槛**默认不验**，SKIP 还不算 FAIL（`343-344`）——
最后一行会打印「9 条 PASS + 1 条 SKIP」然后 exit 0。
→ 把门槛并进默认路径（`--no-build` 才跳过），或把 `--with-build` 写进 README 与工作令的
验收命令。另外 `# tests` 正则只认 node:test 的 TAP 摘要，换 reporter 会静默读成 0，
建议 `count === 0` 时单独提示「可能解析失败」而不是「子测试数 0 < 60」。

## 建议加强（不算缺口）

1. §12.7 只查 `blocked.out.includes(A.id)`；§12.7 的措辞是「exit 1 说明等 A `merged`」，
   建议再断言 `merged` 关键词。
2. §12.2 只测单值根前缀；`ARCHITECTURE-TASKS` §2 还要求「根前缀与其他项混写」也拒绝
   （`--touches . --touches src/a.ts`），建议补这一组。
3. §4 明确 `task add` **不接受 `--status`**，脚本没测；建议加一条（属 CLI 契约，不在 §12 十条内）。
4. 第 4 条成功分支只看退出码，建议同时断言 live `status=claimed` 且 `spec_commit` 非空——
   否则「exit 0 但什么都没写」也能过。

## 复现命令

```bash
cd .cowork/lanes/dsh-m0
sed -n '174,178p' tools/accept-m1.mjs     # A：includes('a')
sed -n '201,214p' tools/accept-m1.mjs     # B：只比退出码
sed -n '286,300p' tools/accept-m1.mjs     # C：缺「不写 live」断言
sed -n '303,316p' tools/accept-m1.mjs     # D：验的是损坏 live，不是半成品 intent
sed -n '319,329p' tools/accept-m1.mjs     # E：默认 SKIP
grep -rn "spawn" test/                    # 无输出：并发门槛测试还没写（§11）
```
