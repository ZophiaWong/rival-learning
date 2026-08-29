# 04 — Full MVP

## Objective

在已验证的核心闭环与可选 repo grounding 上补齐完整 MVP 产品面：三条可控 `AttackChain`、A2A/A2H 控制权切换、完整 checkpoint 形态、历史与 `Gap Map`，以及可日常复用的 Profile UI。

## Required context pointers

开始前依次读取：

1. [`../../CONTEXT.md`](../../CONTEXT.md)：所有展示与状态使用 canonical terms。
2. [`../PRODUCT.md`](../PRODUCT.md) 全文，尤其 InterviewPlan、模式与控制权、Checkpoint 和 MVP 范围。
3. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 的 `SessionEngine`、角色隔离、预算、Repo grounding 和 event stream Interface。
4. [`../adr/0001-application-owned-orchestration.md`](../adr/0001-application-owned-orchestration.md)。

若 `03-repo-grounding` 未完成，或 `STATUS.md` 未将 `04-full-mvp` 标为唯一 `Active milestone`，停止实现。

## In scope

- 默认三链 plan，以及 `needs_input`、排序、禁用与重新生成。
- direct A2H、手动 A2A、`Take Over`、`Hand Back`、`Auto` 和流式取消。
- 主面试三级 hint；已有 Rechallenge outcome 语义不变。
- 纯 A2A checkpoint、完整 session history、summary 和 `Gap Map`。
- Profile create/reuse/edit/duplicate/delete 与 session settings 的完整 UI。
- 三链合计最多十二个正式问题的预算内体验。

## Out of scope

- PDF/DOCX/OCR、语音、云同步、多用户或部署。
- 多 repo、代码写入/执行或远程 clone。
- provider/model 对比和自动 fallback。
- 跨 session 自适应、长期学习状态或延迟复测。
- 本 milestone 之外的性能/安全重构；系统性 hardening 属于 milestone 5。

## Ordered implementation steps

### 1. 扩展为三链 InterviewPlan

生成三个产品定义的不同知识目标，并让用户在 session 开始前处理每条链的状态和顺序。

**完成标准**：

- 默认 plan 精确包含 ownership/claim depth、trade-off/failure、target hiring bar 三种 chain intent，不重复同一知识目标。
- 每条链独立输出证据锚点、初始难度、预计深度和 `AttackChainStatus`。
- 无有效证据的链为 `needs_input`，不能 start；补充 Profile 资料并生成新 snapshot 后可重新生成，或用户可禁用。
- ready/disabled 链可重排；重新生成只替换指定未开始链，不改写已展示问题或历史 chain。
- 所有 enabled chain 的正式问题总数不超过十二，每链仍不超过四。

### 2. 完成模式与控制权命令

在 `SessionEngine.dispatch` 内实现 direct A2H、`Hand Back` 与 `Auto`；保留手动模式和 `Take Over` 的既有规则。

**完成标准**：

- 创建 session 时可选择 A2A 或 direct A2H，模式是 session setting 而非 Profile 字段。
- `Take Over`/`Hand Back` 只在有未作答问题的合法状态切换 actor，均不增加 `QuestionTurn`。
- `Auto` 只自动提交合法的下一命令；遇到 human input、finding calibration、budget pause、typed error 或 checkpoint 必停。
- mode/actor 状态刷新和 restart 后保持；并发手动 action 与 Auto tick 只有一个生效。
- 没有通过 Agents SDK handoff 或 route branch 决定角色。

### 3. 加入取消与三级主面试提示

提供用户可见流式 operation 的取消，并为正式 human question 支持逐级提示；两者保留 transcript 和预算事实。

**完成标准**：

- 取消停止后续流式发布，并将已展示内容与实际 usage 写入 timeline；同一 operation 不自动重放。
- 取消后状态明确为可恢复、可跳过或可结束之一，不留下永久 busy lock。
- 主面试 L1/L2/L3 hint 逐级披露更多支架，每级只能在上一等级后请求并单独计入 provider budget。
- hint 不改写原问题或已提交回答，Judge evaluation 能识别用户使用过的 hint level。
- Rechallenge 仍只以无提示或一次 L1 hint 区分 `ProximalImprovement` 和 `AssistedCorrection`。

### 4. 完成两种 Checkpoint 形态

保留 human checkpoint 的 calibration/rechallenge 路径，并为纯 A2A 链展示观察型复盘。

**完成标准**：

- 有 human answer 的链继续按产品定义的固定顺序完成 finding calibration 与 Rechallenge。
- 纯 A2A 链只显示有效 answer moves、vulnerabilities 和可选 challenge，不创建 `GapFinding` 或 `LearningGap`。
- 混合 actor 的链只对 human answers 生成 finding；AI answer 可作为上下文，但不归因成用户缺口。
- checkpoint 状态可以离开页面后恢复，重复生成命令幂等。

### 5. 建立 History、Summary 与 Gap Map

把 session timeline 投影为可浏览历史、结束摘要和 session 内 gap 视图，不引入跨 session 学习推断。

**完成标准**：

- history 按 chain/turn 显示 actor、question、answer、hint、reflection、evaluation 与 evidence citation。
- summary 显示完成链、正式轮数、request/token usage 和各 outcome 数量，不生成未经证据支持的总分。
- `Gap Map` 只包含当前 session 已校准的 `LearningGap`，显示来源 finding、状态和 rechallenge 结果。
- `inaccurate` finding 可在审计视图看到用户裁定，但不出现在 `Gap Map`。
- 投影由持久化事实可重复生成，refresh/restart 后输出一致。

### 6. 完成 Profile 与 Session 日常 UI

将 foundation 的最小页面提升为清晰的 profile-first 流程，并暴露 session 独立设置与历史保留规则。

**完成标准**：

- 首页先选择、新建或复制 Profile，再进入 ProviderView 确认和 session settings。
- Markdown Project Notes 支持多标题编辑；validation error 指向具体缺失字段。
- Profile list 显示资料/确认更新时间与历史 session 数，不把面试语言、模式或预算存成 Profile identity。
- 删除提示准确说明将保留多少历史 session snapshot；删除后 history 仍完整可读。
- 同一 Profile 新建 session 时 gap、难度和 mode 不继承；完全重复问题只在各自 session 内处理。

## Tests

- Vitest/model tests：三链 intent/needs_input、排序/禁用/局部再生成、4×3 上限、mode transitions、Auto stop matrix、cancel/recovery、三级 hint、mixed/pure-A2A checkpoint、Gap Map projection。
- Role/persistence tests：新模式仍遵守角色隔离、预算、idempotency、operation token 与 restart contract。
- Playwright：Profile reuse/duplicate/delete-history；三链 reorder/disable；direct A2H；A2A Take Over/Hand Back；Auto pause；cancel；human 与 pure-A2A checkpoint；history/summary/Gap Map。
- repo grounding 已启用和未启用两种黄金路径均通过。
- lint、typecheck、production build 通过。

## Milestone completion gate

- Ordered steps 的每条完成标准都有通过的自动测试或可重复验收记录。
- 正式问题上限、请求预算、actor/mode 转换和 checkpoint outcome 的 model-based state tests 穷举所有合法状态分支。
- Playwright 覆盖 In scope 中每个用户可见能力，refresh/restart 后结果一致。
- 用户用至少一个真实私有 Profile 验收三链中的两种 actor 路径；私有内容不进入 git、日志或测试 artifact。
- 搜索确认没有自动 provider/model fallback、跨 session 学习推断、长期掌握宣称或 Out of scope 能力。
- `STATUS.md` 记录 `04-full-mvp` complete，`Active milestone` 恢复为 `none`；不得自行激活 `05-hardening`。

## Stop instruction

达到 gate 后停止。向用户演示完整 MVP、列出实际覆盖的产品证据和剩余可靠性风险；等待用户明确激活 `05-hardening`。
