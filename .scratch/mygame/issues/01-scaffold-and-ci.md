# 01 — 脚手架与部署管道

**What to build:** 建立 monorepo 项目骨架：frontend（React + Vite + TypeScript）、backend（Node + TypeScript + Express + Socket.IO）、shared 共享类型包。后端接通 Postgres。前端经 GitHub Actions 自动部署到 GitHub Pages。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] monorepo 结构（frontend / backend / shared）就绪，TypeScript 全栈
- [ ] backend 启动后可连接 Postgres 并返回健康检查
- [ ] frontend 显示 backend 健康检查结果，证明前后端连通
- [ ] GitHub Actions 在 push 到 main 时自动构建并部署 frontend 到 GitHub Pages
- [ ] 本地一条命令启动开发环境（frontend + backend 同时起）