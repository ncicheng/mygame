# MyGame — 多人在线实时策略对战

基于持久大地图的多人在线实时策略网页游戏。monorepo 结构：前端 React + Vite + TS → GitHub Pages，后端 Node + Express + Socket.IO + TS → Render/Railway，存储 Postgres，共享类型包 `@mygame/shared`。

## 目录结构

```
frontend/   React + Vite + TypeScript 前端（Canvas 地图渲染，后续接入）
backend/    Node + Express + Socket.IO + TypeScript 后端（服务器权威模拟，后续接入）
shared/     前后端共享的 TypeScript 类型
.github/    GitHub Actions 部署管道
```

## 环境要求

- Node.js ≥ 22，npm ≥ 10
- Postgres：本地开发不装也能跑（后端健康检查返回 `db=disconnected`）；集成测试需要真实本地 Postgres（见下）。

## 一条命令启动开发环境

```sh
npm install
npm run dev
```

- 后端：http://localhost:3001 （健康检查 `GET /api/health`）
- 前端：http://localhost:5173 （开发服务器把 `/api` 代理到后端）

## 测试

```sh
npm test                 # 单元测试 + 集成测试（未设 DATABASE_URL 时集成测试自动跳过）
npm run test:integration # 集成测试：必须连真实本地 Postgres
```

集成测试有两种方式提供 Postgres：

1. **embedded-postgres（开箱即用，无需系统安装）**：未设置 `DATABASE_URL` 时，`npm run test:integration` 自动启动内置的真实 PostgreSQL 二进制（仅测试过程运行）。
2. **你自己的本地 Postgres**：设置 `DATABASE_URL` 指向真实实例后运行，例如：

   ```sh
   brew install postgresql@16
   brew services start postgresql@16
   createdb mygame_test
   DATABASE_URL=postgres://localhost:5432/mygame_test npm run test:integration
   ```

## 后端环境变量

复制 `backend/.env.example` 为 `backend/.env`：

| 变量 | 说明 | 默认 |
|------|------|------|
| `DATABASE_URL` | Postgres 连接串，未设置则不连库 | 无 |
| `PORT` | 后端监听端口 | `3001` |

## 部署

push 到 `main` 后 GitHub Actions 自动构建并部署前端到 GitHub Pages（见 `.github/workflows/deploy.yml`）。

生产环境后端地址在构建前端时注入：

```sh
VITE_API_BASE_URL=https://your-backend.example.com npm run build
```

## 文档

- `CONTEXT.md` — 领域词汇表
- `docs/adr/` — 架构决策记录
- `.scratch/mygame/spec.md` — 完整游戏规格