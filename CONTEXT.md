# Rival Learning

Rival Learning 是一个通过观察、应战、发现差距和再次挑战来学习面试知识的单一 bounded context。以下语言用于描述准备资料、面试运行与学习反馈。

## Language

**PreparationProfile**：
可重复使用、可编辑的一组面试准备资料及目标信息，是创建 `Session` 的来源。
_Avoid_：Profile data、Input bundle、Resume set

**ProfileSnapshot**：
创建 `Session` 时锁定的 `PreparationProfile` 内容与配置；之后原档案的变化不影响它。
_Avoid_：Profile copy、Current profile

**ProviderView**：
从准备资料中移除约定联系信息后，获准发送给模型的版本。
_Avoid_：Anonymized profile、Sanitized input

**Session**：
基于一个 `ProfileSnapshot` 开展的独立面试学习过程，不继承其他运行的差距或难度。
_Avoid_：Interview、Run（指完整学习过程时）

**InterviewPlan**：
`Session` 中不可变、由证据支撑的 `AttackChain` 规划；它固定追问目标与边界，但不是预生成的问题列表。
_Avoid_：Question list、Script、Mutable plan

**AttackChain**：
围绕一个知识目标展开、具有明确深度上限的连续追问策略。
_Avoid_：Topic、Question list、Thread

**EvidenceAnchor**：
对该 `Session` 所用 `ProviderView` 中精确连续行范围的本地可验证引用；附近上下文不自动成为证据。
_Avoid_：Context snippet、Model citation、Source hint

**QuestionTurn**：
从一个问题展示给回答者时开始计数的一轮；切换回答者或对同一问题重试仍属于原轮。
_Avoid_：Message、Answer turn、Retry turn

**GapFinding**：
`Judge` 提出的潜在回答缺口，尚未经过用户校准。
_Avoid_：LearningGap、Confirmed gap（在校准前）

**LearningGap**：
用户将 `GapFinding` 校准为准确或部分准确后形成的训练对象。
_Avoid_：Weakness、Mistake、GapFinding（在确认后）

**Benchmark**：
受现有证据约束、面向目标职级的参考回答，用于解释差异而非充当唯一正确答案。
_Avoid_：Ground truth、Perfect answer、Standard answer

**Checkpoint**：
一条 `AttackChain` 结束后，对回答差异进行复盘、校准并选择后续训练目标的阶段。
_Avoid_：Score screen、Final grading

**Rechallenge**：
针对一个 `LearningGap` 提出的新情境变体题，用于检验用户能否迁移刚获得的理解。
_Avoid_：Retry、Repeated question、Quiz

**ProximalImprovement**：
用户在第一次、无提示的 `Rechallenge` 回答中主动覆盖目标维度，表明发生了即时迁移。
_Avoid_：Mastery、Long-term learning、Passed

**AssistedCorrection**：
用户在获得提示后才在 `Rechallenge` 中覆盖目标维度。
_Avoid_：ProximalImprovement、Mastery

**Reflection**：
用户在提交回答后追加的自我复盘；它补充学习记录，但不改写原回答或原评估。
_Avoid_：Answer edit、Regrade request
