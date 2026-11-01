dsh/m3 / 7（用户批准追加独立修复，保留历史） / 98455ba86ae1cb6ea73cede49edca5d0606966c5（最终受验代码；第7提交仅文档，交付提交见分支HEAD）
门禁：npm test = PASS 175/175 / tsc = PASS / build = PASS / accept-m1 = PASS 10/10 / accept-panel = PASS 13/13 / accept-m2 = PASS 20/20 / accept-m3 = PASS 10/10；全部exit=0；完整日志%TEMP%/cowork-logs/2026-11-01-m3-pid-fix/
CI：https://github.com/palmer67/cowork/actions/runs/41312239939 SUCCESS（98455ba，6m30s；纯文档提交按paths-ignore不另跑）；首轮41310375377 FAILURE（M2 17PASS/3FAIL）保留于%TEMP%/cowork-logs/2026-11-01-ci-41310375377-full.log，随后独立修复PID查询上限，未重跑旧输入
已知风险：ADR-M3-01的>260 cwd宿主启动契约待判官裁定；ADR-M3-02的PID查询1s预算待复核；非Windows进程组终止本机未实测
判官需要重点看的点：只读不锁/不恢复与锁内无子进程；旧Git临时克隆预演不改源refs/index及双方hunk；blocked恢复幂等与awaiting_merge取消释放；完整日志见%TEMP%/cowork-logs/2026-11-01-m3/，历史cmd引号失败见同级2026-11-01-m3-behavior-before-cmd-fix.log
