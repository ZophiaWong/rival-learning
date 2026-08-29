# 05 — Hardening

## Objective

在不扩展产品范围的前提下，系统化验证和修复 provider/schema、崩溃/并发、预算、隐私安全、SSE/restart 与浏览器黄金路径，使完整 MVP 可稳定用于本机真实面试准备。

## Required context pointers

开始前依次读取：

1. [`../../CONTEXT.md`](../../CONTEXT.md)：错误恢复不得改变既有领域事实。
2. [`../PRODUCT.md`](../PRODUCT.md) 的成功证据、资料边界和 MVP 范围。
3. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 全文，重点是角色隔离、持久化/恢复、Provider/预算、Repo grounding 与 event stream。
4. [`../adr/0001-application-owned-orchestration.md`](../adr/0001-application-owned-orchestration.md)。

若 `04-full-mvp` 未完成，或 `STATUS.md` 未将 `05-hardening` 标为唯一 `Active milestone`，停止实现。

## In scope

- provider transport/rate-limit/timeout/partial-stream 错误与 schema repair。
- 每个可中断 operation 的崩溃恢复。
- concurrent action、idempotency、budget pause/extend/restart 的压力验证。
- 本地 HTTP、secret/PII、repo scope 与日志/timeline/SSE 隐私审计。
- SSE reconnect、server restart 和 Playwright 完整黄金路径。
- committed 合成 backend/frontend/full-stack fixtures 与 gitignored 私有 fixture 使用说明。

## Out of scope

- 新学习模式、导入格式、账号、云同步、多用户或部署平台。
- 新 provider/model 比较功能或自动 fallback。
- 产品范围外的性能优化、分布式架构或完整 event sourcing。
- 收集或提交真实 Resume、JD、repo 片段、API key 或用户 transcript。

## Ordered implementation steps

### 1. 建立 provider 与 schema failure matrix

为每个 `InterviewAgents` operation 枚举 timeout、连接失败、429、5xx、invalid JSON、valid JSON/invalid schema、retry exhaustion 和 partial stream，并统一 typed outcome。

**完成标准**：

- 每个 operation 在 failure matrix 中都有预期 retry count、budget delta、timeline event、用户提示和可用恢复 action。
- transport/schema 共享首次加两次重试上限；429 backoff 可测试且有总时限。
- schema repair 不越过 request budget，也不把未验证结构提交为 domain state。
- partial stream 保留已显示内容、禁止自动 replay，并提供确定的结束/恢复路径。
- 错误正文、header 和 provider response 中的 secret/PII 在 log 与 UI 前被清理。

### 2. 完成 crash recovery matrix

在 operation reserve 前后、provider request 前后、结果 commit 前后注入进程中断，验证 current state、timeline、usage 与 operation token 的恢复。

**完成标准**：

- 每个可调用 provider 的命令在所有注入点都归入“未开始、可安全重试、结果已提交、需用户决定”之一。
- restart 后不会重复已展示问题/回答、重复创建 gap、重复扩展预算或丢失实际 usage。
- stale operation lock 可在明确超时/owner loss 后转为 typed recoverable state，不允许两个 owner 同时提交。
- `resume_error` 重复调用幂等，且只在保存的 expected state 匹配时提交结果。

### 3. 压测并发、幂等与预算不变量

对同一 session 的 action burst、Auto/manual race、SSE reconnect 和 budget boundary 运行 deterministic stress tests。

**完成标准**：

- 至少 100 组可复现并发序列中，每个合法 state transition 最多提交一次，timeline ordering 可解释。
- 不同 idempotency key 的冲突命令只有一个推进；相同 key 始终返回同一结果。
- request 59/60/61、retry、cancel、restart 和多次 +20 扩展组合均不越界或双计数。
- SQLite busy/locked 情况转换为有界重试或 typed error，不造成 partial domain commit。
- state-model invariant tests 覆盖正式轮数、actor、gap calibration 和 budget 的全部状态。

### 4. 执行安全与隐私审计

用 canary secrets 与 PII 遍历 server/client、database、timeline、SSE、logs、error pages、repo evidence 和 build artifacts 的所有出站面。

**完成标准**：

- 应用只监听 `127.0.0.1`；Host/origin 与 state-changing request 的本地边界有自动测试。
- API key 永不进入 client bundle/response/database/log；合成 PII 只在产品允许的本地 original snapshot 中出现。
- 未确认 `ProviderView` 无法触发 provider operation；确认版本与实际 payload 可审计对应。
- repo traversal/symlink/secret test corpus 全部拒绝，出站 evidence canary 全部被遮蔽。
- dependency/security scan 的 high/critical findings 为零，或每项有用户接受的明确处置记录。

### 5. 固化 SSE、restart 与浏览器黄金路径

验证从任意用户可见等待状态刷新、断线和重启后的恢复行为，并消除重复、乱序与永久 loading。

**完成标准**：

- SSE 使用单调 event id；带 last-event id reconnect 不丢失也不重复应用事件。
- 在 planning、question、answer、evaluation、checkpoint、rechallenge 和 cancel 中分别 restart 后，UI 恢复到唯一合法状态。
- 多 tab 同 session action 显示一致结果，冲突 tab 收到 typed rejection 并可同步最新 state。
- Playwright 不使用固定 sleep，所有等待绑定可观察状态；重复运行无 flaky failure。
- production build 本地启动后的黄金路径与 test server 路径等价。

### 6. 建立合成 fixtures 与私有验收说明

提交不含真实资料的 backend、frontend、full-stack 三套 Profile/repo fixtures，并写清 `fixtures/private` 的本地放置和清理方法。

**完成标准**：

- 三套合成 fixture 各自覆盖 ownership、trade-off/failure 和 target hiring bar 可引用证据。
- fixture 中的姓名、公司、邮箱、token 和 repo 历史均为明确合成内容，通过 secret/PII canary scan。
- `.gitignore` 覆盖 `fixtures/private` 及其生成 artifact；测试证明私有目录存在时不会被 fixture snapshot/报告收集。
- 私有验收说明只描述目录结构、必填字段、运行步骤和安全清理，不包含真实示例内容。
- clean clone 仅靠 committed fixtures 可运行所有非 opt-in tests。

### 7. 执行 release-candidate 验收

从 clean install/migration 开始，用三套合成 fixture 跑完主路径，并由用户选择是否进行一次私有资料验收。

**完成标准**：

- clean install、migration、lint、typecheck、unit/integration tests、production build 和 Playwright 全部通过。
- 三套合成 fixture 分别完成至少一个 A2A/Take Over、direct A2H 或 repo-grounded 变体，并产出可复盘 checkpoint。
- 测试 artifact 通过 secret/PII scan，未包含 hidden Judge data 或未确认资料。
- 已知限制与未解决风险形成简短清单，每项有影响和用户可选处置；不以新增 scope 掩盖失败 gate。

## Tests

- Vitest：failure/crash matrix、state-model property tests、concurrency/idempotency stress、budget accounting、role/privacy contracts、repo security corpus。
- Integration：mock OpenRouter 的 transport/schema/stream cases，临时 SQLite 的 restart/lock cases，SSE reconnect/resume。
- Playwright：Profile lifecycle、三链、各 mode/control、cancel、hints、两类 checkpoint、rechallenge outcomes、history/Gap Map、repo citation/drift、budget pause/extend、error resume、multi-tab。
- Opt-in：显式环境开关下的真实 OpenRouter smoke 和用户私有 fixture run；二者不属于默认 CI，也不保存敏感 artifact。

## Milestone completion gate

- Ordered steps 的所有完成标准有通过的自动证据或用户明确验收记录。
- clean clone 使用合成 fixtures 通过全部默认检查，连续三次 Playwright 全套无 flaky failure。
- failure/crash/concurrency matrices 没有未分类状态；所有 domain invariant 始终成立。
- secret/PII/security audit 无未处置 high/critical finding，private fixture 未被 git 跟踪。
- 产品行为仍在 `PRODUCT.md` 的 MVP 范围内，架构仍遵守唯一 ADR；没有 SDK handoff、LangGraph、LangChain 或自动 provider/model fallback。
- `STATUS.md` 记录 `05-hardening` complete、`Implementation: MVP complete`、`Active milestone: none`，并把 next action 指向用户 release decision。

## Stop instruction

达到 gate 后停止。交付 release-candidate 验收结果、已知限制和可复现运行说明；不得自行开始 post-MVP 功能或部署工作。
