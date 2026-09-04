# Rival Learning Product

本文是用户行为、学习规则、产品范围与成功标准的唯一来源。领域词义以 [`../CONTEXT.md`](../CONTEXT.md) 为准。

## 产品定位

首版是本机运行的单用户自用工具。面试准备是 competition-driven learning 的第一个应用场景；首版验证学习闭环是否对产品所有者本人有用，不据此宣称市场验证已经完成。

核心循环为：

`Observe → Challenge → Discover Gaps → Improve → Rechallenge`

- `A2A`：用户观察 `Interviewer` 与目标职级 `Candidate` 的持续问答，探索一个问题可以追到多深。
- `A2H`：`Interviewer` 直接挑战用户，并根据当前表现逐步逼近目标岗位的 hiring bar。
- 两种模式属于同一过程。用户可在问题展示后 `Take Over`，也可在完整 MVP 中 `Hand Back` 给 `Candidate`。

## MVP 成功标准

MVP 验证即时迁移，canonical outcome 是 `ProximalImprovement`。它不等同于长期掌握、延迟记忆或实际面试表现提升。

一次成功证据由三部分共同构成：

1. `Judge` 对 `Rechallenge` 的结构化判定。
2. 用户将相关 `GapFinding` 校准为准确或部分准确。
3. 用户人工复盘 transcript，确认问题、回答与差异解释符合上下文。

仅在第一次、无提示 `Rechallenge` 中主动覆盖目标维度时记录 `ProximalImprovement`。一次 L1 提示后成功记录 `AssistedCorrection`；仍未覆盖记录 `unresolved`；用户跳过记录 `deferred`。

这套证据用于个人自测，不是独立第三方评估。

## PreparationProfile 与复用

用户必须先创建或选择 `PreparationProfile`，再创建 `Session`。档案包含：

- 名称。
- Resume 文本。
- 单一 Markdown `Project Notes` 字段；可用标题组织多个项目。
- JD 文本。
- 目标岗位。
- 职级。
- 可选的单一 repo 路径。

目标岗位和职级必填；Resume 或 `Project Notes` 至少填写一项。面试语言、起始模式与模型调用预算是 `Session` 设置，不属于档案身份。

`PreparationProfile` 可以编辑、复用、复制和删除。每个 `Session` 保存创建时的不可变 `ProfileSnapshot`：

- 修改档案不回写已有 `Session`。
- 删除档案前明确提示已有历史资料仍由 `Session` 快照保留；确认删除后这些快照继续可读。
- 从同一档案创建的多个 `Session` 彼此独立，不继承 `LearningGap` 或难度。
- 生成问题与同一 `Session` 已展示问题规范化后完全相同时，系统重新生成；不同 `Session` 之间不承诺去重。

## ProviderView 与资料边界

本机保存用户原始资料。系统以确定性本地规则生成 `ProviderView`，默认遮蔽：

- 姓名。
- 邮箱。
- 电话。
- 详细地址。
- 联系方式与个人主页 URL。

公司、项目、技术和量化指标予以保留。脱敏保持行数稳定，使证据锚点仍能对应原资料。该过程是 contact-data minimization，不承诺完整匿名化。

首次创建档案或相关资料发生变化后，用户必须预览并确认新的 `ProviderView`。资料未变化时，新 `Session` 复用已确认版本，无需重复确认。`Session` 同时保留原始 `ProfileSnapshot`、实际使用的 `ProviderView` 与 `redactionVersion`，以便回看模型当时获得的上下文。

## InterviewPlan 与 AttackChain

完整 MVP 默认生成三条可排序、禁用和重新生成的 `AttackChain`：

1. `ownership / claim depth`：验证候选人实际承担的工作、决策和证据是否支撑 Resume 或项目声明。
2. `trade-off / failure`：追问替代方案、取舍、失败模式、监控和恢复。
3. `target hiring bar`：根据目标岗位与职级验证所需的系统性、范围和判断力。

每条链须带知识目标、资料中的证据锚点、初始难度和预计追问深度。证据不足时状态为 `needs_input`，用户只能补充资料后重新生成，或禁用该链；系统不得把假设性情境写成用户过去的真实经历。

每条链最多四个 `QuestionTurn`，三条链最多十二轮正式问题。问题一经展示即计数；同题 `Take Over`、回答者切换或重试不增加轮数。`Rechallenge` 和提示后的重答不计入正式轮数。

## 模式与控制权

- 默认 A2A 采用固定的两步手动推进：对当前未回答问题显式请求一次 `Candidate` 回答；回答结算后，再由用户显式请求下一问题。回答成功不会自动触发追问。
- 用户只能在问题已经展示且尚未回答时 `Take Over`；该问题仍是同一个 `QuestionTurn`，不会增加轮数。控制权随后保持为 A2H，直至当前链结束。
- 完整 MVP 支持直接从 A2H 开始、`Hand Back`、`Auto` 连续推进和流式取消。
- `Auto` 只改变推进方式，不改变轮数、预算、资料可见性或 checkpoint 规则。

## Checkpoint

`AttackChain` 结束后按固定顺序执行：

1. 为该链中的每个用户回答批量生成有证据约束的 `Benchmark`。
2. `Judge` 先按 rubric 独立评价，再借助 `Benchmark` 解释差异。
3. 展示 difference-first 报告；完整 `Benchmark` 默认折叠。
4. 每次最多提出三个 `GapFinding`。
5. 用户逐项校准为 `accurate`、`partial` 或 `inaccurate`。
6. 只把 `accurate` 或 `partial` 转为 `LearningGap`；`inaccurate` 是用户的最终裁定，不参与难度调整或 `Rechallenge`。
7. 展示针对已接受差距的 micro-explanation。
8. 对最高优先级 `LearningGap` 发起一次即时 `Rechallenge`。

用户可以在提交回答后追加 `Reflection`，但它不修改原评估，也不倒推改变已生成的追问。

纯 A2A 链的 checkpoint 只展示参考回答中的有效 moves、可能被攻击的位置和可选挑战，不凭空创建用户的 `LearningGap`。

## MVP 范围

验收所需的真实 Resume/JD 只存放在 gitignored 的 `fixtures/private`。仓库提交内容仅包含合成的 backend、frontend 与 full-stack fixtures。

以下内容不在 MVP：

- PDF、DOCX 和 OCR 导入。
- 语音面试。
- 云账号、同步和多用户。
- 多 repo 或代码执行。
- provider/model 能力对比。
- 跨 `Session` 的长期学习状态。
- 延迟复测和长期掌握结论。
