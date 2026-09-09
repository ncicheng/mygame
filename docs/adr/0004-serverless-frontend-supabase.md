# 无服务器前端 + Supabase

游戏逻辑在浏览器客户端执行，复用 `shared/` 中的纯函数（行军、战斗实例、招募、进度结算）；数据通过 Supabase Auth + Postgres（启用 RLS）存储，前端部署在 GitHub Pages。

考虑过自建 Node + Socket.IO 服务器权威后端（0002），但其运维成本高、需要持续跑世界时钟，而当前是单玩家 PvE MVP，实时多人对战的负载诉求尚不成立。选择无服务器架构换取零运维与成本，代价是对世界模拟和反作弊失去服务器权威控制。

## 决策

- 前端（React + Vite + TS）直接调用 Supabase。
- 游戏逻辑客户端执行，复用 `shared/` 纯函数，保证前后端（重构前/后）逻辑一致。
- Supabase Auth 负责身份，Postgres + RLS 存储数据。
- 不再维护持久 Node 服务器 / Socket.IO / ticker 世界时钟。
- GitHub Actions 构建前端，注入 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`，push 到 `main` 自动部署 GitHub Pages。

## 取舍与反作弊

客户端计算结果可由作弊者篡改（纯客户端模拟）。对单玩家 PvE MVP 可接受；转向多人 PvP 时需重新引入服务器权威结算，届时再评估。

Status: accepted
