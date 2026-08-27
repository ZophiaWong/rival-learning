# Rival Learning Architecture

本文定义实现约束、Module、Interface、seam 和 Adapter。产品行为以 [`PRODUCT.md`](PRODUCT.md) 为准，领域语言以 [`../CONTEXT.md`](../CONTEXT.md) 为准；编排选择的理由见 [`adr/0001-application-owned-orchestration.md`](adr/0001-application-owned-orchestration.md)。

## 技术基线

- Next.js App Router 与 TypeScript strict mode。
- Node.js 22。
- Tailwind CSS。
- Zod v4 负责外部输入和模型结构化输出的 runtime validation。
- SQLite、Drizzle ORM 与 better-sqlite3。
- Vitest 负责 module/interface tests，Playwright 负责浏览器黄金路径。

首版默认绑定 `127.0.0.1`。API key 只从 server environment 读取，不进入浏览器 bundle、SQLite、timeline、日志或导出内容。

## Module map

```text
Routes / UI
    │ SessionCommand
    ▼
SessionEngine ───────────────► Persistence
    │ domain operations              │
    ▼                                └─ current state + immutable timeline
InterviewAgents
    │ internal RoleRunner seam
    ├─ OpenRouter / Agents SDK Adapter
    └─ Scripted Adapter

PreparationProfiles ──► ProfileSnapshot + ProviderView ──► SessionEngine
RepoScope ─────────────► read-only evidence tools ─────────► Candidate / Judge only
```

Routes 只验证 transport 输入、鉴权本地请求、调用 Module interface 并映射结果；不编排面试步骤。

## PreparationProfiles Module

`PreparationProfiles` 拥有以下行为：

- `PreparationProfile` 的 create、read、update、duplicate 和 delete。
- 必填项与“Resume / Project Notes 至少一项”的校验。
- 确定性、本地 `ProviderView` 脱敏和 `redactionVersion`。
- 行数保持、预览确认状态和资料变化后的确认失效。
- 创建不可变 `ProfileSnapshot`，同时锁定实际获准发送的 `ProviderView`。

其 Interface 返回完整结果或 typed domain error；调用方不重做脱敏、确认或 snapshot 规则。

## SessionEngine Module

`SessionEngine` 是流程的唯一所有者。它通过一个 command-driven Interface 暴露行为：

```ts
type DispatchResult =
  | { status: "applied"; session: SessionView; events: TimelineEvent[] }
  | { status: "duplicate"; session: SessionView }
  | { status: "rejected"; error: SessionCommandError };

interface SessionEngine {
  dispatch(command: SessionCommand): Promise<DispatchResult>;
}
```

该 Module 把以下复杂度隐藏在 `dispatch` 后：

- session 状态机与合法转换。
- `QuestionTurn` 计数和规范化重复问题检测。
- A2A/A2H、`Take Over`、`Hand Back` 与 `Auto` 的控制权。
- provider request 预算和 token usage。
- `Checkpoint`、finding calibration、`LearningGap`、提示和 `Rechallenge`。
- per-session serialization、operation token、idempotency 和错误恢复。

`SessionCommand` 是 discriminated union，至少覆盖：

```ts
type SessionCommand =
  | { type: "generate_plan"; sessionId: string; idempotencyKey: string }
  | { type: "start"; sessionId: string; idempotencyKey: string }
  | { type: "request_ai_answer"; sessionId: string; idempotencyKey: string }
  | { type: "take_over"; sessionId: string; idempotencyKey: string }
  | { type: "hand_back"; sessionId: string; idempotencyKey: string }
  | { type: "submit_human_answer"; sessionId: string; answer: string; idempotencyKey: string }
  | { type: "append_reflection"; sessionId: string; reflection: string; idempotencyKey: string }
  | { type: "request_hint"; sessionId: string; level: 1 | 2 | 3; idempotencyKey: string }
  | { type: "calibrate_finding"; sessionId: string; findingId: string; calibration: FindingCalibration; idempotencyKey: string }
  | { type: "start_rechallenge"; sessionId: string; learningGapId: string; idempotencyKey: string }
  | { type: "resume_error"; sessionId: string; operationToken: string; idempotencyKey: string }
  | { type: "extend_budget"; sessionId: string; idempotencyKey: string };
```

命令的合法前置状态、可观察事件、错误类别和重复提交结果属于 Interface contract，并通过 Interface tests 固定。

## InterviewAgents Module

`InterviewAgents` 向 `SessionEngine` 暴露领域操作，而不是通用 chat primitive：

- 生成结构化 InterviewPlan。
- 生成下一问题。
- 生成 `Candidate` 回答。
- 评价单轮回答。
- 批量生成链末 `Benchmark`。
- 生成 `Checkpoint` 的 `GapFinding` 与差异解释。
- 生成提示和 `Rechallenge`，并评价即时迁移结果。

每项操作接收显式角色上下文、结构化输入与 operation token，返回通过 Zod 校验的 domain result 和实际 usage。`SessionEngine` 不接触 prompt、provider payload 或工具循环。

### RoleRunner internal seam

`RoleRunner` 是 `InterviewAgents` 内部 seam，至少有两个 Adapter：

- production Adapter：OpenAI Agents SDK + 通用 OpenAI-compatible client；MVP 首个入口为 OpenRouter。
- test Adapter：确定性的 Scripted/fake runner，可脚本化结构化结果、usage、重试和错误。

Agents SDK 只执行一个角色的一次领域操作，包括结构化输出、受限重试与该角色允许的工具循环。它不保存或推进 `Session`，不使用 handoff 选择下一个角色，也不向 routes 暴露 SDK Session。

同一个 seam 可在明确配置后接入 DeepSeek 或其他 OpenAI-compatible 国内平台的直连 endpoint。应用只执行用户配置的精确 provider/model，不因失败自动切换 provider 或模型。

## 角色隔离

每个 operation 重新组装最小角色上下文，不共享可变 message history：

- `Interviewer` 可见访谈所需的 `ProviderView`、InterviewPlan、当前链和公开 transcript；不可调用 repo 工具，也不可见隐藏的 `Judge` 分析。
- `Candidate` 可见回答所需资料、公开 transcript，以及启用 repo grounding 后的只读证据工具。
- `Judge` 可见 rubric、待评回答、必要上下文与证据工具；其内部判定只通过 `SessionEngine` 选择的产品字段向用户披露。

用户可见的 `Candidate` 输出与问题一旦展示，就成为 timeline 事实。角色切换不会把其他角色的隐藏上下文转交给新角色。

## 持久化、并发与恢复

持久化使用两个互补视图：

- current state row：高效读取并验证下一条命令。
- immutable timeline：保存用户可见事件、模型 usage、operation outcome 和恢复所需事实。

这不是完整 event sourcing；current state 是权威的运行快照，不要求从 timeline 重建所有内部状态。

外部模型调用期间不持有 SQLite transaction。一次可能调用 provider 的命令按以下协议运行：

1. 在短 transaction 中校验状态与 idempotency key，写入唯一 operation token，并保留该 `Session` 的串行执行权。
2. transaction 外调用 `InterviewAgents`。
3. 在新的短 transaction 中按 operation token 比对预期状态；只提交一次 domain result、usage、timeline events 和新 current state。
4. 进程中断后，将未完成 operation 标记为可恢复错误；`resume_error` 依据已保存事实决定安全重试或继续提交。

相同 idempotency key 重复提交返回第一次已提交结果，不重复推进流程或扣减已记录 usage。并发 action 只能有一个获得相应 session operation token。

## Provider 与预算

角色级 server env 分别指定 provider base URL、API key 引用和精确 model slug。配置状态接口只返回“是否已配置”、安全的 provider 名称和 model slug，不返回 key、header 或完整环境变量。

OpenRouter production Adapter 使用 Chat Completions，并设置：

- `provider.require_parameters: true`
- `provider.data_collection: "deny"`
- `store: false`
- 应用自有最小 metadata；不包含原始 Resume/JD/Project Notes
- hosted tracing 关闭

应用不进行 model/profile fallback。OpenRouter 在同一精确模型 slug 下选择兼容上游 endpoint 的容灾可以存在。

一次底层 provider HTTP request 计一次预算，包括 Agent 工具循环或结构化修复触发的额外请求。每个 `Session` 默认上限为 60；到达上限后进入 `budget_paused`，只有 `extend_budget` 可每次增加 20。UI 同时展示 request count、limit 和累计 input/output token usage。

transport error 与 schema error 共享每个 domain operation 的“首次请求 + 最多两次重试”。任何流式内容一旦展示给用户，该 operation 不自动重放；用户通过明确恢复 action 决定后续行为。每次实际请求无论成功与否都写入 usage/accounting 事实。

## Repo grounding

Repo grounding 是核心闭环验收后的可选能力，由 `RepoScope` Module 拥有：

- 仅接受一个绝对 repo path；保存 realpath 和 Git fingerprint。
- 所有读取先做 realpath confinement，拒绝越出根目录的路径。
- 跳过 symlink、secret、二进制、依赖目录和超大文件。
- 对可发送片段再次执行 secret redaction。
- 只向 `Candidate` 与 `Judge` 提供 `listFiles`、`searchCode`、`readFile` 三个只读工具。
- 每次保存实际使用的文件路径、fingerprint、行范围和脱敏证据片段。
- 历史记录的 fingerprint 与当前 repo 不一致时展示 drift warning，不静默重解释旧证据。

工具返回 typed denial 或 bounded result；调用方不能获得任意 filesystem primitive。Repo grounding 不提供写文件、执行代码或网络访问。

## 公共状态类型

```ts
type FindingCalibration =
  | "unreviewed"
  | "accurate"
  | "partial"
  | "inaccurate";

type LearningGapStatus =
  | "open"
  | "improved"
  | "assisted_correction"
  | "unresolved"
  | "deferred";

type AttackChainStatus =
  | "ready"
  | "needs_input"
  | "disabled";
```

`GapFinding` 必须先以 `FindingCalibration = "unreviewed"` 存在。只有 `accurate` 或 `partial` 会创建 `LearningGap`；`inaccurate` 不映射成 `LearningGapStatus`。

## HTTP 与 event stream Interface

公开 routes 至少包括：

```text
GET    /api/profiles
POST   /api/profiles
GET    /api/profiles/:id
PATCH  /api/profiles/:id
DELETE /api/profiles/:id
POST   /api/profiles/:id/duplicate

GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id
DELETE /api/sessions/:id
POST   /api/sessions/:id/actions
GET    /api/sessions/:id/events

GET    /api/config/providers
```

`POST /actions` 只接收 `SessionCommand` 的 transport representation；所有状态转换仍由 `SessionEngine.dispatch` 决定。`GET /events` 使用 SSE 发布可公开的 timeline/state 更新，支持断线后按 event id 续读；它不发送 prompt、hidden reasoning、API key 或未披露的 `Judge` 数据。
