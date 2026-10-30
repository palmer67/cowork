# M1 验收流程与合 main 清单（验收人自用）

> 只有 §11 的门槛满足后才能从这里往下走。跑之前先在 `dsh-m0` 车道看一遍现场。

## 0. 前置：冻结现场

```bash
cd .cowork/lanes/dsh-m0
git status --short          # 只允许出现 .cowork/notes/*.md（未入库的说明），不允许 src/ test/ 有改动
git log --oneline -1        # 记下这个 sha，它就是本轮验收集合
date
```

三项门槛，缺一项就退回去，不跑验收：

```bash
npm test                    # 退出码必须 0，且 TAP 摘要 # tests ≥ 60
npx tsc --noEmit            # 必须无输出
```

把 `# tests` 的实际数字抄进结论文档。**「差不多 60」不算过**——M1 的验收脚本自己也数这个数。

## 1. 构建 + 验收

```bash
npm run build
node tools/accept-m1.mjs
```

预期：十条 PASS。只单跑一条时加 `--allow-missing` 跳过前置探测（这时前面必须已经 build 过，
否则跑的是旧产物）。

记录方式：整段输出存到 `.cowork/notes/2026-10-30-m1-acceptance-run.md`，含 sha、node 版本
（`node -v`，基线是 v22.14.0）、`# tests` 实际数、十行结果原文。

## 2. 每条红分别意味着什么

| 红的是 | 含义 | 处理 |
|---|---|---|
| 1/2（touches 校验） | CLI 参数面坏了 | 打回小东，不给合 |
| 3（占位冲突文案） | 冲突识别或文案退化 | 打回；若只是缺 agent 字样，可要求补消息 |
| 4（并发领取） | 事务有竞态，**最严重** | 打回，不许用「偶发」解释；要求给出 claims==lease 的证据 |
| 5/6（ready 门、spec_commit） | 状态机或 catalog 读取问题 | 打回 |
| 7（依赖门） | 依赖只看 merged 这条没落实 | 打回 |
| 8（lane new 不写 live） | 有隐形写盘 | 打回 |
| 9（半成品 intent 回滚） | 崩溃恢复缺口 | 打回；这是 M1 的核心卖点 |
| 10（测试数/类型检查） | 数量不够或类型不干净 | 打回，等它补 |
| 脚本自身探测失败 | 构建产物缺失或 `assertImplemented` 拦住了 | 先 `npm run build`；仍失败看是不是「未知命令」伪装 |

## 3. 关于「已知必红」

接手时被告知：M0 的 `doctor` 对损坏的 live task JSON 静默 `exit 0`，所以脚本里那条
「写坏 live、要求 doctor 退 1」会红。这条对应工作令 §9（doctor 最小检查），**不是** §12 的
半成品 intent 条。小东这轮若按 §9 实现了 doctor 检查，它应该转绿；**没转绿就是 M1 没做完**，
不能以「已知必红」放行——否则等于把一个「读坏了当没读」的静默吞数据口子合进 main。

## 4. 合 main（验收绿了之后才做，做之前先跟用户说一声）

陷阱与走法：

```bash
git worktree list                 # 先确认 main 有没有被哪个工作树占着
```

- **不要在根工作树合**：根工作树停在 `codex/task-layer-architecture`，在那合会把那个分支
  推到 main 前面，且它没有 src/，容易合出半成品。
- **不要 `git branch -f main`**：那会把小东的基线移走（它还在这个基线上工作）。
- 走法：`git worktree add .cowork/lanes/main main`（或直接在主仓库 `git switch main` 如果
  main 没被占用），在 main 上 `git merge --no-ff dsh/m0`，然后 `npm test` 再跑一遍
  （合并后绿才算绿），再 `git push origin main`。
- 合并提交信息写清：M1 = 任务层（spec/live/next/brief/doctor/snapshot 接线），验收命令与结果。
- 合完更新 README 的状态表，并把「M0 完成」那行推进到 M1。

## 5. 合完之后

- 通知小东把车道 rebase 到新 main（它后续要做 M2，基线不能再挂在 7d01a13）。
- 本轮遗留（不阻塞 main，但要记进 DECISIONS 或 M2 待办）：
  - `cowork --help` 报「未知命令」的小瑕疵；
  - `confirmMerge` 不做 owner 校验、`git rev-parse` 在锁外跑（M1 可接受，M2 要重看）；
  - 锁外读 live 的例外契约（P4）、trunk 不重验的降级（P5）的兜底依赖 doctor。
