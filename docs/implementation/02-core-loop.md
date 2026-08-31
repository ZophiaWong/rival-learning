# 02 — Core Loop

## Objective

在单一 `AttackChain`、最多四个 `QuestionTurn` 的约束下，完成可真实自用的 `A2A → Take Over → A2H → Checkpoint → Rechallenge` 闭环。达到工程 gate 后，由用户使用私有 fixture 完成一次真实运行并复盘，才允许讨论下一 milestone。

## Required context pointers

开始前依次读取：

1. [`../../CONTEXT.md`](../../CONTEXT.md)：重点区分 `GapFinding`、`LearningGap`、`ProximalImprovement` 与 `AssistedCorrection`。
2. [`../PRODUCT.md`](../PRODUCT.md) 的产品定位、MVP 成功标准、模式与控制权、`Checkpoint`。
3. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 的 `SessionEngine`、`InterviewAgents`、`RoleRunner`、角色隔离、Provider/预算和 event stream Interface。
4. [`../adr/0001-application-owned-orchestration.md`](../adr/0001-application-owned-orchestration.md)。

若 `01-foundation` 未完成，或 `STATUS.md` 未将 `02-core-loop` 标为唯一 `Active milestone`，停止实现。

## In scope

- 一条有证据锚点的 `AttackChain`，最多四个正式问题。
- 固定手动推进的 A2A，并允许问题展示后 `Take Over` 进入 A2H。
- OpenRouter production `RoleRunner` Adapter 和角色级精确 model 配置。
- 单轮 Judge evaluation、链末逐题 `Benchmark`、difference-first `Checkpoint`、最多三个 `GapFinding`。
- 用户校准、`LearningGap`、micro-explanation、L1 hint 和一次即时 `Rechallenge`。
- 默认 60 次实际 provider request 预算、每次 +20 扩展、request/token usage 展示。
- 核心路径所需的 SSE 更新、明确错误与恢复 action。

## Out of scope

- Repo grounding。
- 三条链、链排序/禁用/重新生成和 `needs_input` UI。
- 直接 A2H 起步、`Auto`、`Hand Back`、三级主面试提示。
- 纯 A2A checkpoint、完整 history/summary/Gap Map。
- PDF/DOCX/OCR、语音、模型比较和跨 session 学习状态。

## Ordered implementation steps

### 0. 完成 Foundation review-remediation entry gate

在接入真实 provider 前修复 Foundation review 中已确认的 transport、幂等与验收缺口；该步骤使用独立 PR，且不得引入 Agents SDK、OpenRouter Adapter 或面试核心循环。

**完成标准**：

- 所有 `/api` route 拒绝非 loopback Host；写请求拒绝缺失或不同源 Origin。
- 外部 HTTP body、action 与 `Idempotency-Key` 使用 Zod runtime validation，错误稳定映射为 400/403。
- Session 创建由客户端提供 UUID identity；相同 key 与相同 command 重放第一次终态结果，不同 command/payload 使用同一 key 时返回 typed conflict。
- `DispatchResult` 文档与实现统一为原结果重放；前端使用 canonical `PreparationProfile` 类型。
- `/events` 保持 SSE 连接，按 `Last-Event-ID` 续读并由 UI 去重，断开时释放轮询与心跳资源。
- secret canary tests 覆盖序列化 response、header 与 log；`contact-v1` 保持不变，其已知限制由 GitHub Issue 跟踪。
- entry-remediation PR 的 test、lint、typecheck 与 production build 全部通过；PR 创建后停止，合并前不开始下一步。

### 1. 完成 production RoleRunner Adapter

在 `InterviewAgents` 内部 seam 实现 OpenRouter/Agents SDK Adapter，并保持 Scripted Adapter 可运行同一组 interface tests。

**完成标准**：

- SDK-neutral `RoleRunner` Interface 固定角色、operation、prompt 输入、Zod output schema、abort/delta callback，以及 typed result、逐请求 attempt 和 usage；SDK 类型不进入 `SessionEngine`。
- 每个角色从 server env 读取受控 provider ID、独立 API key 和精确 model slug；缺失或不支持配置不阻止启动，并在调用前返回 typed error。
- OpenRouter Adapter 使用 Chat Completions、实例级 client/provider/runner、关闭 hosted tracing 和内部 retry；request 带有架构文档规定的 privacy/routing 参数与最小 metadata。
- transport/schema error 共用首次加两次无状态重试；测试确定复现 0、1、2 次 retry、最终失败、错误分类、`Retry-After` 和 usage 不完整语义。
- Scripted 与 production Adapter 运行同一组 Interface contract tests；受控 mock server 证明应用不会切换 model/provider 或产生 tracing 请求。
- 只有提供 callback 时才流式执行；首个 delta 交付后、callback 失败或用户 abort 后不自动重放。该 callback 在本步骤不接入 SSE/UI。
- opt-in 三角色 OpenRouter live smoke 只使用合成输入并输出脱敏摘要；默认 test suite 和 CI 不发起外部请求。

### 2. 生成并执行单一 AttackChain

实现一条结构化链的 planning、问题生成、规范化去重与最多四轮状态转换；使用现有 `ProviderView` 证据，不生成无来源的过去经历。

**完成标准**：

- plan 输出知识目标、至少一个有效资料证据锚点、初始难度和 1–4 的预计深度。
- 无法获得有效证据时 operation 返回可操作的 `needs_input` 结果，不虚构锚点。
- 问题展示时且仅在此时增加 `QuestionTurn`；同题 actor switch/retry 不增加。
- 第五个正式问题被 `SessionEngine` 拒绝。
- 与本 session 已展示问题规范化后完全重复的生成结果会在可用重试内重新生成，仍重复则显式失败。

### 3. 实现固定 A2A 到 Take Over 路径

默认由用户逐步触发问题与 `Candidate` 回答；任一已展示且尚未作答的问题可 `Take Over`，随后由用户提交回答。

**完成标准**：

- 验收 session 至少能展示一次 A2A candidate answer，再在后续已展示问题上 `Take Over` 并提交 human answer。
- `Take Over` 在问题展示前、问题已结算后或 model operation 进行中均被 typed state error 拒绝。
- `Interviewer`、`Candidate`、`Judge` 的实际组装输入符合角色隔离测试；`Interviewer` payload 不含隐藏 Judge 字段。
- 所有用户可见问题/回答只追加一次 timeline，刷新或 SSE reconnect 不重复。
- 此路径没有 direct-A2H、`Auto` 或 `Hand Back` 控件与命令入口。

### 4. 评价回答并生成 Checkpoint

保存 rubric-first turn evaluation；链结束时对 human questions 一次批量生成 `Benchmark`，再产生 difference-first 报告和最多三个 `GapFinding`。

**完成标准**：

- Judge evaluation 在接收 `Benchmark` 前生成并持久化 rubric result；后续解释不能覆写它。
- 链末一个 batch operation 为每个 human answer 返回证据约束的 `Benchmark`，数量与顺序精确对应。
- 默认视图先展示差异与证据，完整 `Benchmark` 可折叠展开。
- 每个 finding 初始 calibration 为 `unreviewed`，数量为 0–3，并带目标维度、依据和优先级。
- 纯 A2A 或没有 human answer 时不创建用户 finding；本 milestone 可以明确提示该 checkpoint 形态尚未实现。

### 5. 校准并完成 Rechallenge

让用户拥有 finding 的最终校准权；只针对已接受 finding 创建 gap，并对最高优先级 gap 进行 micro-explanation、无提示变体题与最多一次 L1 hint。

**完成标准**：

- `accurate`/`partial` 各自创建一个可追溯到 finding 的 `LearningGap`；`inaccurate` 不创建 gap，也不影响后续难度或选题。
- 校准重复提交幂等，校准完成后不可被 provider 结果静默修改。
- `Rechallenge` 与原题情境不同但目标维度相同，不增加正式轮数。
- 第一次无提示成功转为 `improved` 并记录 `ProximalImprovement`；一次 L1 hint 后成功转为 `assisted_correction`；失败为 `unresolved`；跳过为 `deferred`。
- `Reflection` 只追加到 timeline，不改变原 answer、evaluation、finding 或既有 follow-up。

### 6. 强制 request budget 与 usage 可见性

在所有真实和 Scripted provider call path 的最低层统一记账，由 `SessionEngine` 决定暂停和扩展。

**完成标准**：

- 初始 limit 为 60；初始请求、retry、schema repair 和 tool-loop request 都逐一增加 count。
- 到达 60 后，在发起第 61 个 request 前进入 `budget_paused`，非 `extend_budget` 命令不能继续模型操作。
- 每次 `extend_budget` 精确增加 20 且写入 timeline；重复 idempotency key 不重复增加。
- UI 在 session 运行与暂停状态均显示 count/limit 和累计 input/output tokens。
- crash/retry 后从持久化 usage 恢复，不重置或双计数。

### 7. 完成核心闭环 UI 与恢复体验

将手动控制、差异报告、校准、解释、提示和结果连成一个可刷新恢复的 session 页面。

**完成标准**：

- 用户可以从已确认 Profile 创建 session，并完成整个 Objective 所述路径。
- 等待 provider 时 UI 显示当前 operation；typed failure 显示可操作说明和明确的 `resume_error` action。
- SSE reconnect 或页面刷新后恢复到同一可操作状态，不丢失已展示内容。
- hidden Judge data、provider payload、secret 与未确认资料不出现在 DOM、client state 或浏览器网络响应。

## Tests

- Interface tests 同时运行 Scripted 与 production Adapter 的共同 contract；production HTTP 使用受控 mock server，不消耗真实额度。
- Vitest 覆盖四轮上限、问题去重、actor switch 计数、非法状态、角色隔离、Judge-before-Benchmark、calibration 映射、四种 rechallenge outcome、Reflection 不变性、budget/retry/idempotency/restart。
- Playwright 黄金路径：A2A candidate answer → 新问题 Take Over → human answer → Checkpoint → 校准 → micro-explanation → unhinted/hinted Rechallenge outcome。
- 一项 opt-in smoke test 可在显式环境开关下调用 OpenRouter；默认 test suite 不联网。
- lint、typecheck 与 production build 通过。

## Milestone completion gate

工程 gate 要求：

- Ordered steps 的全部完成标准有通过的自动测试或可重复验收记录。
- Scripted Playwright 黄金路径、restart 场景和 60 次预算边界通过。
- opt-in OpenRouter smoke test 使用合成资料成功，request/privacy/model 参数经日志的脱敏摘要核对。
- 搜索确认没有 repo 工具、direct A2H、`Auto`、`Hand Back`、三链、SDK handoff、LangGraph 或 LangChain 实现。
- `STATUS.md` 记录 engineering gate complete，但 `Active milestone` 恢复为 `none`，`Next action` 指向 user acceptance；不得激活 `03-repo-grounding`。

产品 gate 要求用户亲自使用 `fixtures/private`（内容不提交）完成一次真实闭环，并人工复盘：证据锚点、追问深度、finding 准确性、差异解释和 rechallenge 判定。复盘结论与需要修改的核心问题必须记录后再决定是否进入 milestone 3。

## Stop instruction

工程 gate 达到后立即停止开发，交付真实自测步骤和复盘问题。用户完成产品 gate 并明确批准之前，不修建 repo grounding，也不扩展到完整 MVP。
