# 01 — Foundation

## Objective

建立可本地运行和测试的工程底座，完成 `PreparationProfile → ProviderView confirmation → ProfileSnapshot → Session` 的持久化路径，并以 fake `InterviewAgents` 证明 `SessionEngine.dispatch` 可以确定地推进状态。此阶段不连接真实 provider。

## Required context pointers

开始前依次读取：

1. [`../../CONTEXT.md`](../../CONTEXT.md)：使用 canonical domain language。
2. [`../PRODUCT.md`](../PRODUCT.md) 的 “PreparationProfile 与复用” 和 “ProviderView 与资料边界”。
3. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 的技术基线、`PreparationProfiles Module`、`SessionEngine Module`、持久化/并发、公共状态类型和 HTTP Interface。
4. [`../adr/0001-application-owned-orchestration.md`](../adr/0001-application-owned-orchestration.md)：保持 application-owned orchestration。

若 `STATUS.md` 未将 `01-foundation` 标为唯一 `Active milestone`，停止实现。

## In scope

- 使用用户激活 milestone 时确认的 package manager 和初始化方式创建 Next.js/TypeScript 工程。
- 配置 runtime validation、SQLite/Drizzle migration、Vitest 与基础 Playwright 配置。
- `PreparationProfiles` Module 的 CRUD、duplicate、本地脱敏、确认失效和 snapshot。
- `SessionEngine.dispatch` 的状态骨架、current state、immutable timeline、operation/idempotency 基础结构。
- Scripted/fake `InterviewAgents` Adapter。
- 能完成本 milestone 验收演示的最小本地 UI 与 routes。

## Out of scope

- 任何真实 provider、API key 或 Agents SDK 网络调用。
- 完整 InterviewPlan、真实问题/回答、`Checkpoint`、`LearningGap` 或 `Rechallenge`。
- Repo grounding、三链、直接 A2H、`Auto`、`Hand Back`。
- PDF、DOCX、OCR、语音、账号或部署。

## Ordered implementation steps

### 1. 初始化工程与质量命令

按激活时确定的工具初始化技术基线，启用 TypeScript strict，并提供开发、构建、lint、typecheck、unit test、Playwright 与 migration 命令。

**完成标准**：

- `package.json` 声明选定的 package manager，并存在唯一对应 lockfile。
- fresh install 后，development server 可绑定 `127.0.0.1` 启动。
- build、lint、typecheck、unit test 命令均以退出码 0 完成。
- 不存在真实 provider SDK 调用或用户资料 fixture。

### 2. 建立 server configuration Interface

用 Zod 在 server 启动边界校验数据库路径、host 与可选 provider 配置；浏览器只能读取安全配置状态。

**完成标准**：

- 缺失必需配置时启动失败并返回不含 secret 的可操作错误。
- server-only module 读取 API key；client import 会被构建或测试阻止。
- `GET /api/config/providers` 只返回 configured flag、安全 provider 名称和 model slug。
- 单元测试证明响应、日志和序列化错误均不包含测试 secret。

### 3. 创建数据库 migration 与 persistence primitives

建立支持档案、已确认脱敏版本、不可变 session snapshot、session current state、timeline、operation token 和 idempotency result 的最小 schema。

**完成标准**：

- 空数据库可通过 committed migration 一次建立；重复执行不破坏数据。
- migration 后的约束可拒绝 orphan snapshot/event 和重复 operation token。
- timeline row 创建后没有 update path；删除 `PreparationProfile` 不级联删除 `Session` 或其 snapshot。
- persistence tests 在临时 SQLite 数据库运行，不依赖开发者机器状态。

### 4. 实现 PreparationProfiles Module

通过一个 Module Interface 完成校验、CRUD、duplicate、确定性 contact-data redaction、预览确认和 snapshot；routes 与 UI 只调用该 Interface。

**完成标准**：

- 目标岗位/职级缺失或 Resume 与 Project Notes 均为空时，create/update 返回 typed validation error。
- 同一输入与同一 `redactionVersion` 产生 byte-identical `ProviderView`，并保持原文本行数。
- 姓名、邮箱、电话、详细地址和联系 URL 的合成样例被遮蔽；公司、技术和指标样例被保留。
- 改变相关资料会使旧确认失效；确认后未变化的资料可直接 snapshot。
- duplicate 生成新 identity 和可编辑副本；删除原档案后，已存在 snapshot 仍可读取。
- Module interface tests 覆盖以上每条规则。

### 5. 实现 SessionEngine 状态骨架

实现 `dispatch(SessionCommand)` 的最小命令集：创建后的 session 可经 fake plan/start action 推进；所有推进写入 current state 与 timeline。

**完成标准**：

- `Session` 只能从已确认 `ProviderView` 创建，并锁定 `ProfileSnapshot`、实际 `ProviderView` 与 `redactionVersion`。
- 合法 fake command 产生确定 state 与 timeline；非法状态命令返回 typed rejection 且不产生部分写入。
- 相同 idempotency key 返回原结果；两个并发命令只有一个推进同一 session。
- fake `InterviewAgents` 可脚本化成功、typed failure 和 usage，不导入 production provider Adapter。
- 外部 operation 模拟等待期间没有开放的 SQLite transaction。

### 6. 建立 foundation 验收路径

提供最小页面完成 Profile list/create/read/update/duplicate/delete、`ProviderView` preview/confirm 和创建 `Session`；显示 fake 状态与 timeline 供核对。

**完成标准**：

- 浏览器中可从空数据库创建合法档案、确认脱敏内容并创建 session。
- 修改资料后 UI 阻止使用旧确认创建新 session，重新确认后恢复。
- 删除拥有历史 session 的档案前出现保留历史资料的明确提示，删除后 session 仍可查看。
- 页面刷新与 server restart 后，档案、snapshot、session state 和 timeline 保持一致。

## Tests

- Vitest：配置 secret safety、redaction fixtures、Profile validation/reuse/delete、migration constraints、`SessionEngine` transition/idempotency/concurrency。
- Playwright：创建 Profile → 预览确认 → 创建 Session → 修改后重新确认 → duplicate → 删除 Profile 后读取历史 Session。
- 静态检查：lint、typecheck、production build。
- 所有测试使用合成资料和 fake `InterviewAgents`；测试期间不得发起网络模型请求。

## Milestone completion gate

只有以下条件全部满足，`01-foundation` 才完成：

- Ordered steps 的每条完成标准都有自动测试或可重复验收记录对应，且全部通过。
- fresh database migration、production build、Vitest 和 foundation Playwright 路径通过。
- 搜索代码确认不存在 route-level 状态编排、SDK handoff、LangGraph、LangChain 或真实 provider 调用。
- git diff 只包含本 milestone 范围内的工程、代码、migration、测试和必要文档状态更新。
- `STATUS.md` 已记录 `01-foundation` complete，并把 `Active milestone` 恢复为 `none`；不得自行激活 `02-core-loop`。

## Stop instruction

达到 gate 后停止。向用户演示 foundation 验收路径，报告测试结果与遗留风险，并等待用户明确激活 `02-core-loop`；不得开始真实 provider 或核心面试闭环。
