# 昵称 + 领地显示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyGame 添加玩家昵称（军团成员显示昵称）与领地大小显示。

**Architecture:** 复用 `profiles` 表（username 作为昵称）——种子触发器为新用户播种默认昵称；`profiles_select` 放开到所有登录用户（供军团成员互看昵称）；数据层加 fetchNickname/setNickname；UI 显示昵称编辑与领地大小（拥有城池数）。

**Tech Stack:** React 18 + Vite + TS、Supabase Postgres + RLS + 现有 data.ts 模式。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：昵称/军团/城池/领地
- `profiles.username` 作为昵称；种子 `seed_new_user` 为新用户播种默认昵称（唯一）
- `profiles_select` 放开到所有登录用户（军团成员互看昵称）；`profiles_update` 仅本人（改昵称）
- 领地大小 = 玩家拥有的城池数（`cities.owner_user_id` 计数）
- 中文注释；2 空格；遵循 data.ts/Schema 模式；复用前端测试基建

---

### Task 1: 昵称 schema（profiles 播种 + RLS 放开）+ 领地数据

**Files:**
- Modify: `supabase/schema.sql`、`frontend/src/data.ts`
- Test: `frontend/test/data.test.ts`

**Interfaces:**
- Produces:
  - `seed_new_user` 播种 profiles：`INSERT INTO profiles (user_id, username) VALUES (NEW.id, '玩家' || left(NEW.id::text,6));`
  - `profiles_select` 改为 `auth.uid() IS NOT NULL`（登录用户可见昵称）
  - data.ts：`fetchNickname(userId, client?): Promise<string | null>`、`setNickname(userId, nickname, client?): Promise<void>`、`fetchTerritory(userId, worldId, client?): Promise<number>`（count cities where owner=userId）

- [ ] **Step 1: schema 改动**

`seed_new_user` 加 profiles 播种；`profiles_select` 放开。

- [ ] **Step 2: data.ts 加 fetchNickname/setNickname/fetchTerritory + 测试**

TDD：mock client 验证各函数读写正确表。

- [ ] **Step 3: 构建 + 测试 + Commit**

```bash
git add supabase/schema.sql frontend/src/data.ts frontend/test/data.test.ts
git commit -m "feat: 昵称 + 领地数据层"
```

---

### Task 2: 昵称编辑 + 领地显示 UI（含军团成员昵称）

**Files:**
- Modify: `frontend/src/WorldView.tsx`、`frontend/src/RightColumn.tsx`、`frontend/src/LeftColumn.tsx`

**Interfaces:**
- Consumes: data.ts 的 fetchNickname/setNickname/fetchTerritory
- Produces:
  - 玩家昵称编辑入口（显示昵称 + 可改）
  - 领地大小显示（拥有城池数，如"领地 N 城"）
  - 军团成员列表显示昵称（fetchNickname 批量）

- [ ] **Step 1: WorldView 拉取 nickname/territory 并传给各卡**

- [ ] **Step 2: 军团成员列表显示昵称**（为成员 user_ids 批量 fetchNickname）

- [ ] **Step 3: 昵称编辑 + 领地显示 UI**

- [ ] **Step 4: 构建 + 测试 + Commit**

```bash
git add frontend/src/WorldView.tsx frontend/src/RightColumn.tsx frontend/src/LeftColumn.tsx
git commit -m "feat: 昵称编辑 + 领地显示 + 军团成员昵称"
```

---

## Self-Review

**Spec 覆盖：** 昵称播种/RLS/数据（Task1）、领地数据（Task1）、UI（Task2）——覆盖。
**Placeholder 扫描：** 无 TBD。
**类型一致性：** fetchNickname/fetchTerritory 签名 Task1 定义、Task2 消费一致。
