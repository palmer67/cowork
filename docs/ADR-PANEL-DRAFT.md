# ADR 草案归档：M1.5 工单与 M1 行为

状态：判官已裁定（2026-10-31）；依据本地 main a10f6a0 的 WORKORDER-PANEL §12
及判官在本会话的明确回复。本文保留问题与裁定，不引入新协议。

1. **退出码（R1）**：保持 M1。顺序重复 next 返回 1；只有锁外候选在取锁前被别人领走
   才可能返回 2。既有占位使候选为空也返回 1，CLI 原文应含路径及占用者。
   工单 §8.9 仍写 2；验收按判官“保留 M1，不改 CLI，其余一律 1”执行并显式标注，
   不改退出码、不伪造输出、不通过制造竞争满足旧字面。
2. **只读验收（R2）**：比较 commonDir/cowork 下 tasks、claims、intents、leases 四个
   子目录及 .cowork/tasks 的文件集合与 mtime，包含子目录 mtime。只豁免既有 mutex 的
   瞬时活动，不豁免持久状态。实际锁目录名为 lock；不改 M1 mutex 实现。
3. **身份（R3）**：拒绝客户端 agent 字段；next 的 cwd、COWORK_AGENT_ID 与 --agent
   由服务端按车道设置。状态动作保留根目录调用者身份，快照 owner 仅展示，CLI 拒绝
   身份不符时原样呈现，不新增代操作协议。

面板仅遥控 CLI（D11）；计划导入只创建 draft，提交 trunk 后才能 ready（D12）。
