# 服务器权威 + 自建 Node 后端

世界模拟、行军、战斗实例由自建 Node+TypeScript 服务器权威计算（Express + Socket.IO），前端仅渲染与上报意图；持久化用 Postgres，部署在 Render/Railway，前端挂 GitHub Pages。

考虑过 Supabase（Auth + Postgres + Realtime 全托管），但它面向 CRUD 应用，承载不了需要持续跑世界时钟与权威模拟的实时逻辑。自建 Node 服务器换取对世界状态和反作弊的完全控制，代价是运维自己承担。

Status: accepted