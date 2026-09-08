# MyGame 无服务器重构设计

日期：2026-09-08
状态：accepted

## 背景

原实现为"自建 Node 后端 + 服务器权威"（ADR-0002）。因部署需要常驻服务器与支付卡，改为**无服务器**：游戏逻辑在前端计算，Supabase 仅作数据存储。此改动推翻 ADR-0002（服务器权威），并新增全界面酷炫 UI 与版权标识需求。

## 新架构

```
浏览器（前端 React）
  ├─ Supabase Auth       注册/登录（替代 /api/auth）
  ├─ Supabase Postgres   同一份 schema，存储全部数据
  ├─ shared/ 纯逻辑      战斗/行军/兵种/武器/养成（本地计算）
  └─ 无 Socket.IO / 无服务器 ticker
```

前端部署仍为 GitHub Pages。无需后端服务器。

## 各部分改造

| 层 | 原实现（backend/） | 改为 |
|----|------------------|------|
| 认证 | Express /api/auth + scrypt 哈希 | Supabase Auth（内置） |
| 数据库 | 本地 Postgres + `backend/src/schema.ts` | Supabase Postgres（SQL 迁移执行原 schema） |
| 数据读写 | `db.ts` + 各 service SQL | 前端 `@supabase/supabase-js` 直连读写 |
| 战斗 | `battle.ts` 服务端结算 | `shared/combat.ts` 前端结算 → 结果写 Supabase |
| 行军 | `march.ts` + ticker + Socket.IO | 本地按时间戳插值（`shared` 纯函数）；无 ticker/WS |
| 招募/养成 | `recruit.ts` / `progression.ts` | 前端调 shared 逻辑 + Supabase 读写 |
| 实时 | Socket.IO 推送 | 前端轮询 + 本地计算 |

## 保留 / 移除

- **保留**：`shared/` 全部纯逻辑（combat/marchPositionAt/troops/weapons/progression）、`CONTEXT.md` 领域词汇、变体 C「运筹帷幄」指挥台布局、schema 表结构、GitHub Pages 前端部署。
- **移除**：`backend/` 目录、Socket.IO、服务器权威（ADR-0002 更新为"已弃用"）。

## 关键取舍（已与用户确认）

- **客户端计算 = 玩家可作弊**（可篡改本地战力/资源/战斗结果）。MVP 为单机打野 PvE，无 PvP 对抗，可接受；将来多人对战需回到服务器权威。
- Supabase 免费层：Auth + Postgres 足够；Edge Functions 本设计不使用。
- 前端用 Supabase **anon key 直连数据库**，必须配置 **Row Level Security (RLS)** 防串读/串改。

## 数据安全（RLS）

为每一张数据表启用 RLS，策略：

- **按 owner 隔离**：`users`、`resources`、`weapons`、`generals`、`army_units`、`action_points`、`progression`、`cities`、`wildlands`、`marches`、`battle_instances`、`battle_reports` 均以 `auth.uid()` 关联，用户只能读/写自己的行。
- **世界只读公开**：`worlds`、`world_tiles` 所有登录用户可读（共享世界）。
- 具体每表的 `SELECT/INSERT/UPDATE/DELETE` 策略随实施计划逐表列明。

## 界面需求

- **全界面酷炫化**（含登录/注册页）：在现代 React 后端改造的同时，为登录页、注册页、主界面（变体 C 指挥台）、招募、战斗、养成等所有界面做动态炫酷视觉——动效、渐变、粒子/光效、层次感，契合仙侠/三国战争主题。
- **版权标识**：所有界面（含登录页）底部/角落标注 **`Powered By 杨子轩@五年级`**。

## 测试

- 前端单元测试：shared 纯逻辑沿用（已在 shared 内）。
- 集成测试：对 Supabase 的 RLS 策略与数据读写用前端逻辑 + Supabase 本地/托管实例验证。

## 相关决策变更

- **ADR-0002（服务器权威自建 Node 后端）→ 标记 deprecated**，新增 ADR 记录本无服务器重构。
