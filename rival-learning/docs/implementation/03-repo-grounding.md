# 03 — Repo Grounding

## Objective

在已通过用户真实自测的单链核心路径上，为 `Candidate` 和 `Judge` 加入受 `RepoScope` 限制的只读代码证据，使项目回答与评价可以引用实际片段，同时阻止路径逃逸、secret 外发和历史证据被 repo 变化静默改写。

## Required context pointers

开始前依次读取：

1. [`../../CONTEXT.md`](../../CONTEXT.md)：保持面试与学习对象命名一致。
2. [`../PRODUCT.md`](../PRODUCT.md) 的 ProviderView、InterviewPlan 与 MVP 范围。
3. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 的角色隔离、持久化和 `Repo grounding`。
4. [`../adr/0001-application-owned-orchestration.md`](../adr/0001-application-owned-orchestration.md)。

若核心闭环产品 gate 未经用户接受，或 `STATUS.md` 未将 `03-repo-grounding` 标为唯一 `Active milestone`，停止实现。

## In scope

- 一个 Profile 对应至多一个绝对 repo path 的 `RepoScope`。
- realpath confinement、Git fingerprint 和明确的 repo access confirmation。
- `listFiles`、`searchCode`、`readFile` 三个 bounded read-only tools。
- symlink、secret、二进制、依赖目录和超大文件防护。
- 出站 evidence secret redaction、证据 snapshot/citation 和 drift warning。
- 仅向 `Candidate` 与 `Judge` 暴露工具；继续使用单一 `AttackChain` 核心路径。

## Out of scope

- 多 repo、远程 repo clone、代码写入或执行。
- `Interviewer` repo access。
- 三条链、direct A2H、`Auto`、`Hand Back` 或 full-MVP reporting。
- 通用 RAG、embedding/vector database 或代码索引服务。

## Ordered implementation steps

### 1. 建立 RepoScope identity 与确认

在 Profile 配置中解析一个绝对路径，保存 root realpath 与 Git fingerprint，并在 session snapshot 中锁定用户确认的 scope。

**完成标准**：

- 相对路径、不存在路径、非目录和无法读取路径返回不同 typed error。
- root path 经 realpath 固定；fingerprint 至少区分 repository identity、HEAD commit 与 dirty state。
- 创建 session 前 UI 展示 root realpath、fingerprint 和只读能力并要求确认；路径或 fingerprint 变化使旧确认失效。
- session snapshot 不依赖 Profile 之后的路径编辑，且不保存 repo 文件全集。

### 2. 实现路径与文件安全策略

所有工具共用一个 policy，在任何文件读取前完成 realpath confinement、类型、目录、大小和敏感路径检查。

**完成标准**：

- `..`、绝对子请求、编码后的 traversal、root-prefix 混淆和跨根路径均被拒绝。
- 指向 scope 外的 symlink、symlink directory 和循环 symlink 不被跟随。
- `.git`、依赖/构建目录、已知 secret 文件、二进制和超过配置上限的文件返回 typed denial。
- allow/deny decision 有不含内容与 secret 的审计事件。
- 同一 policy 的 table-driven tests 覆盖每种 allow 与 denial 类别。

### 3. 实现三个 bounded tools

通过 `RepoScope` Module Interface 提供 `listFiles`、`searchCode`、`readFile`，统一限制结果量、单片段大小和 operation 总证据量。

**完成标准**：

- `listFiles` 只返回相对路径和安全元数据，排序稳定且有上限/截断标记。
- `searchCode` 将 query 作为数据处理，不允许 shell 拼接；返回有界 match、文件路径和行号。
- `readFile` 只读经 policy 允许的文本范围，强制行/byte 上限并返回截断状态。
- Interface 不暴露 filesystem handle、任意 glob、shell 或 network primitive。
- 相同 repo snapshot 与请求产生稳定结果，便于 Scripted tests 重放。

### 4. 脱敏并保存实际证据

对即将发送给 provider 的代码片段执行确定性 secret redaction，并只保存角色实际使用的证据 snapshot。

**完成标准**：

- 合成 API key、private key、credential assignment 和高置信 token 在出站前被遮蔽。
- 普通 identifier、技术细节和非 secret 指标保持可用于面试。
- evidence record 包含 session、operation、角色、fingerprint、相对路径、行范围、redaction version 和实际脱敏片段。
- transcript citation 可打开保存的 evidence snapshot，而不是重新读取当前文件。
- 原始 secret 不出现在 SQLite、timeline、log、SSE 或测试 snapshot。

### 5. 接入 Candidate/Judge 并验证角色隔离

在 `RoleRunner` tool loop 中按角色注入最小工具集，并让回答/evaluation 明确引用使用过的 evidence id。

**完成标准**：

- `Candidate` 与 `Judge` 可以调用三个工具，并且每个底层模型请求计入 session budget。
- `Interviewer` 的工具 schema、prompt payload 和运行时 registry 均不含 repo tools。
- 未被 tool result 返回的代码不能被标记为 grounded evidence；无证据时输出明确降级而非伪造 citation。
- `Judge` 可区分用户声明、Profile evidence 与 repo evidence。
- 角色隔离 contract tests 对三个角色分别断言可见字段与工具。

### 6. 展示 citation 与 repo drift

在问题、回答和 checkpoint 中展示可追溯 citation；历史 fingerprint 与当前 repo 不同则显示 drift warning。

**完成标准**：

- 每个 citation 显示相对路径、行范围和 capture fingerprint，可查看保存片段。
- repo 未变化时不显示误报警告；HEAD、dirty state 或 root identity 变化时显示 drift warning。
- warning 不重跑历史评价，也不替换历史证据；用户仍可查看 capture-time snapshot。
- 页面刷新/server restart 后 citation 与 drift 状态保持一致。

## Tests

- Vitest table tests：realpath/path traversal、prefix collision、symlink escape/loop、secret/binary/dependency/oversize denial、tool bounds、secret redaction、fingerprint/drift。
- Role contract tests：Candidate/Judge 可调用，Interviewer 不可调用；evidence id 与实际 tool result 对应。
- Budget tests：每个 tool-loop provider request 单独计数，暂停前不越过 limit。
- Playwright：确认 repo → grounded candidate/human flow → checkpoint citation → 修改临时 Git repo → 查看 drift warning 和原证据。
- 所有 repo tests 在临时合成 Git repository 运行，不读取 workspace 外的真实用户项目。

## Milestone completion gate

- Ordered steps 的每条完成标准均有通过的自动测试或可重复验收记录。
- 全套路径逃逸、symlink 与 secret canary 测试证明无内容越界或 secret 泄漏。
- 单链 Playwright 路径中的 `Candidate` 或 `Judge` 至少产生一个可打开、capture-time 稳定的 grounded citation。
- 对 repo 变更的 drift warning 通过 restart 测试，历史 evaluation 未被修改。
- 搜索确认没有多 repo、代码执行、repo 写入、`Interviewer` 工具、三链或 full-MVP mode 实现。
- `STATUS.md` 记录 `03-repo-grounding` complete，`Active milestone` 恢复为 `none`；不得自行激活 `04-full-mvp`。

## Stop instruction

达到 gate 后停止。向用户演示路径拒绝、grounded citation 和 drift warning，报告安全测试结果，并等待用户明确激活 `04-full-mvp`。
