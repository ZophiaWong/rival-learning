# Core Loop 自测与复盘

## 运行一次自己的学习闭环

1. 按 README 配置三个 OpenRouter 角色并运行 `pnpm dev`。真实 Resume/JD 可放在 gitignored 的 `fixtures/private/`；将文本粘贴到页面，不提交这些文件。
2. 创建 PreparationProfile，填写目标岗位、职级，以及 Resume 或 Project Notes。预览并确认 ProviderView，再创建 Session。
3. 生成计划并开始。第一题显式请求一次 Candidate 回答，再点击继续追问。
4. 在后续尚未回答的问题上 Take Over，提交自己的回答。继续至该链完成，生成 Checkpoint。
5. 先读差异和依据，按需展开 Benchmark 与五维 rubric。将每项 finding 校准为准确、部分准确或不准确；已校准的裁定固定保存。
6. 有已接受 gap 时开始即时 Rechallenge。阅读简短解释，回答新的情境题。第一次不使用提示且覆盖目标维度时得到 `ProximalImprovement`。
7. 第一次未覆盖目标维度时，可以使用一次 L1 提示，再答一次；成功记录 `AssistedCorrection`，否则为 `unresolved`。也可以结束并记录未解决，或暂缓为 `deferred`。
8. 可为已提交的正式个人回答追加 Reflection。刷新页面，确认原回答、评价、校准、提示与结果保留。每个 Session 独立。

## 预算与恢复

- 页面显示 requests / limit、输入与输出 tokens。默认 60 次，重试也计数；耗尽后点击增加 20 次预算，再恢复并继续。
- 模型调用失败或服务重启中断时，页面保留明确的恢复按钮。修正模型配置后需重启服务再恢复。
- Checkpoint 从未完成的阶段继续，已保存的逐题评价和 Benchmark 不重新生成。Rechallenge 回答先保存，评价失败后可以继续评价该回答。
- 无法获知的中断请求 token 数显示为用量不完整；已预留的请求仍计入预算，避免重启后重复获得额度。
- 所有 finding 都判为不准确，或没有 finding 时，本次复盘直接完成，不创建训练 gap。

## 人工复盘问题

- 证据锚点是否忠实于你确认的资料？追问是否足够深入？
- 差异解释与 finding 是否指出了真实、值得练习的缺口？
- 新问题是否换了情境但仍检验同一维度？解释是否提前给出了新题答案？
- Judge 对覆盖维度的判定是否符合原回答？你是否真的在第一次无提示回答中主动用到了新理解？

可把结论保存在 `fixtures/private/core-loop-review.md`：记录 Session ID、结论、关键问题及是否接受当前闭环。真实 transcript 留在本地。

工程验收后等待这次个人自测；用户接受并明确激活之前，不进入 repo grounding 或完整 MVP。
