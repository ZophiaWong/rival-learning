# Application-owned orchestration

三角色面试流程由 application-owned `SessionEngine` 编排，OpenAI Agents SDK 仅留在 `InterviewAgents` 的 `RoleRunner` 内执行单角色模型调用。这个选择把用户接管、角色资料隔离、隐藏的 `Judge` 输出、预算、`Checkpoint`、幂等提交和错误恢复放在可确定测试的状态机中；当前流程分支明确，因此不采用 SDK handoff、LangGraph 或 LangChain 来拥有流程。
