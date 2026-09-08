# MyGame — 多人在线实时策略对战

基于持久大地图的多人在线实时策略网页游戏。monorepo 结构：前端 React + Vite + TS → GitHub Pages，存储 Supabase（Postgres + RLS），共享类型包 `@mygame/shared`。无持久后端。

## 目录结构

```
frontend/   React + Vite + TypeScript 前端（Canvas 地图渲染，游戏逻辑客户端执行）
shared/     前后端共享的 TypeScript 纯函数与类型
.github/    GitHub Actions 部署管道
```

## 环境要求

- Node.js ≥ 22，npm ≥ 10
- Supabase 项目（用于认证与数据存储）

## 本地开发

```sh
npm install
cp frontend/.env.example frontend/.env   # 填入 Supabase URL 与 anon key
npm run dev
```

- 前端：http://localhost:5173
- 开发环境数据由浏览器直连 Supabase，无需本地后端。

## 测试

```sh
npm test    # 前端 + shared 单元测试
```

## 环境变量

前端通过 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY` 直连 Supabase（见 `frontend/.env.example`）：

| 变量 | 说明 |
|------|------|
| `VITE_SUPABASE_URL` | Supabase 项目 URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon public key |

## 部署

1. 在 [Supabase](https://supabase.com) 创建项目。
2. 在项目 SQL 编辑器执行 `supabase/schema.sql` 建表。
3. 在 GitHub 仓库设置 GitHub Actions variables：`VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`。
4. push 到 `main`：GitHub Actions 构建前端（注入上述变量）并自动部署到 GitHub Pages。

## 文档

- `CONTEXT.md` — 领域词汇表
- `docs/adr/` — 架构决策记录
- `.scratch/mygame/spec.md` — 完整游戏规格
