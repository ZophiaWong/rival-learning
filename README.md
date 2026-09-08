# Rival Learning

本机单用户面试学习工具。当前支持单条 AttackChain 的 A2A 观察、Take Over 作答、Checkpoint 校准和即时 Rechallenge。

## 本地运行

使用 Node.js 22 和 package.json 指定的 pnpm 版本。

```sh
pnpm install
# 首次使用时复制 .env.example 为 .env.local，并配置三个角色。
pnpm dev
```

打开 http://127.0.0.1:3000。三个角色的 provider 都填写 `openrouter`，分别设置精确 model slug 和 API key。已有 `.env.local` 无需覆盖。数据库 migration 在启动时自动执行。

## 验收

[核心闭环自测与复盘](docs/implementation/02-core-loop-acceptance.md) · [当前实现状态](docs/implementation/STATUS.md)

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:e2e
```

默认测试使用合成资料和 Scripted 或本机 mock server。真实模型验证需显式开启：

```sh
RIVAL_RUN_LIVE_TESTS=1 pnpm test:smoke:openrouter
```
