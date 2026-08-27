# Rival Learning Agent Instructions

- **领域语言**：命名或修改领域概念前，读取 [`CONTEXT.md`](CONTEXT.md)，并沿用其中的 canonical English identifier。
- **产品规则**：修改用户流程、学习规则、产品范围或成功标准前，读取 [`docs/PRODUCT.md`](docs/PRODUCT.md)。
- **架构规则**：修改 orchestration、Agent、provider、持久化、公开接口、repo grounding 或隐私处理前，读取 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 及其指向的相关 ADR。
- **实现工作**：写代码前，读取 [`docs/implementation/STATUS.md`](docs/implementation/STATUS.md)。只有存在 `Active milestone` 时才加载并执行对应 milestone；逐项满足其完成标准和 completion gate，然后服从其 stop instruction。`Active milestone: none` 时停止实现并与用户讨论激活下一 milestone。
