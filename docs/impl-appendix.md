# 实现附录 — 上游契约细节（实现时实测发现）

这些是从上游 validator 源码与实测中固化的契约细节，修订/补充设计文档：

1. **coverage-ledger.json 顶层是数组**（不是 `{units:[...]}`）。`Ledger` 已按此实现。
2. **`attempts` 只存归档的既往分配**：每项必须含 `reviewed_paths / local_checks /
   result_fingerprints / unresolved / reassignment_reason`，且 `wave` 必须严格小于当前
   wave —— **fresh retry 必须把 wave +1**。当前分配直接写在顶层 `agent_id / wave`。
3. **covered/candidate 必须有证据**：非空 `reviewed_paths + local_checks +
   result_fingerprints`，且 local_checks 的路径必须与 aggregate reviewed_paths 互相闭合；
   fingerprints 是受约束 token `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`（无空格）。
   证据不足只能记 `blocked` + `unresolved[]`。该纪律已写进 agent 证据契约（prompts.js）。
4. **planned 单元 `agent_id` 必须为 null**（validator 强制）。
5. **canonical coverage_id 由 canonical_refs 推导**：`fields.map(encode).join('::')`
   （fields = surface/boundary/subsystem/attack_class [+lifecycle]）。

## API 调研带来的设计修正（docs/dsh-plugin-api-notes.md）

- **面板无 host push API**：dsh-ui 围栏/panel 只能由 agent assistant 消息驱动。
  v1 面板 = 发起会话的 agent 轮询 `audit_status`（结构化落盘状态）后渲染
  `panel:true` 卡片；引擎侧零前端代码。
- **subagent 池**：`ctx.subagents.start("spawn", {label, prompt, signal})` +
  `settleRun`（一次性），与 dsh-tool-subagent 同路径；每个引擎 agent 一个 child。
- **后台运行**：v1 引擎作为插件内追踪的异步任务 + 全磁盘状态（重启后可
  `audit_status` 读盘恢复视图）；v1.5 再评估迁到 `ctx.jobs`。
- **安装**：`dsh plugin --profile web add /Users/mars/jobs/dsh-cf-sas`，改 JS 需重启
  （cordis-plugin-hmr 默认关闭）。

## 验证状态

- 晋升程序（promote.js）：symlink / `..` / 中段 `..` 拒绝 ✓，常规晋升 ✓。
- Ledger 状态机：valid commit / assign / recordResult / wave-bump reassign ✓；
  坏文档被上游 validator 拒绝且磁盘保留 last-good ✓（ENGINE_INVARIANT_VIOLATION）。
- 待做：findings.json 全链路、六阶段引擎接线到真实 subagent、probe 安装审批 UI、
  HTML 报告渲染器、`dsh plugin --profile web add` 实装验证。
