# 后台管理页面实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyGame 添加后台管理页面：管理员可管理账号（设等级/星级/武器/兵种解锁/资源/昵称）并设置游戏参数。

**Architecture:** `profiles.is_admin` 标记管理员；管理操作走 SECURITY DEFINER RPC（校验 auth.uid() 是管理员，服务器权威防越权）；`game_params` 键值表存可配置参数。前端管理员可见后台页。

**Tech Stack:** React 18 + Vite + TS、Supabase Postgres + RLS + SECURITY DEFINER RPC、现有 data.ts 模式。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：武将/兵/武器/资源/养成/昵称/管理员
- 管理操作必须服务器权威（SECURITY DEFINER RPC 校验 is_admin），客户端不能直接改他人数据
- `profiles` 加 `is_admin boolean NOT NULL DEFAULT false`；拥有者用 SQL 一次性标记自己
- `game_params` 键值表（key text PK, value text）+ 管理 RPC 读写
- 前端后台页仅 is_admin 用户可见
- 中文注释；2 空格；遵循 data.ts/Schema 模式；复用前端测试基建

---

### Task 1: 管理 schema（is_admin + game_params + 管理 RPCs）

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces:
  - `profiles` 加 `is_admin boolean NOT NULL DEFAULT false`
  - `game_params(key text PK, value text NOT NULL)` 表
  - 管理 RPCs（均 SECURITY DEFINER，首行校验 `IF NOT (SELECT is_admin FROM profiles WHERE user_id=auth.uid()) THEN RAISE EXCEPTION '无管理员权限'`）：
    - `admin_list_users() RETURNS jsonb`（列出所有用户：id/email/nickname/general level+stars/weapon tier/resources/progression troop_unlock/is_admin）
    - `admin_set_general(p_user_id, p_level, p_stars)`
    - `admin_set_weapon_tier(p_user_id, p_tier)`
    - `admin_set_troop_unlock(p_user_id, p_max_level)`
    - `admin_adjust_resources(p_user_id, p_food, p_iron, p_rare, p_gold)`（增量，可负）
    - `admin_set_nickname(p_user_id, p_nickname)`
    - `admin_set_admin(p_user_id, p_is_admin)`
    - `admin_get_params() RETURNS jsonb`、`admin_set_param(p_key, p_value)`

- [ ] **Step 1: schema 加 is_admin + game_params + 管理 RPCs**

中文注释，SECURITY DEFINER + 管理员校验 + 事务。游戏侧（seed/RLS）同步：profiles 默认 is_admin=false。

- [ ] **Step 2: 静态校验 + Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: 管理 schema + RPCs"
```

---

### Task 2: 管理数据层 + 前端路由/入口

**Files:**
- Modify: `frontend/src/data.ts`、`frontend/src/App.tsx`、`frontend/src/auth.ts`
- Test: `frontend/test/data.test.ts`

**Interfaces:**
- Produces:
  - data.ts：`fetchIsAdmin(userId)`、`adminListUsers()`、`adminSetGeneral(...)`、`adminSetWeaponTier(...)`、`adminSetTroopUnlock(...)`、`adminAdjustResources(...)`、`adminSetNickname(...)`、`adminSetAdmin(...)`、`adminGetParams()`、`adminSetParam(...)`
  - App.tsx：检测 is_admin，管理用户时渲染后台入口/路由

- [ ] **Step 1: data.ts 管理函数 + 测试**（TDD，mock client 调 rpc）

- [ ] **Step 2: App.tsx 管理入口**（is_admin 用户可见"后台"入口，路由到 AdminPage）

- [ ] **Step 3: 构建 + 测试 + Commit**

```bash
git add frontend/src/data.ts frontend/src/App.tsx frontend/src/auth.ts frontend/test/data.test.ts
git commit -m "feat: 管理数据层 + 入口"
```

---

### Task 3: AdminPage UI（用户列表 + 编辑 + 参数）

**Files:**
- Create: `frontend/src/AdminPage.tsx`
- Modify: `frontend/src/App.tsx`、`frontend/src/world.css`/`theme.css`

**Interfaces:**
- Consumes: Task 2 的 admin 函数
- Produces:
  - 用户列表（昵称/邮箱/武将等级/星级/武器/兵种解锁/资源/管理员）
  - 每行编辑：设等级/星级/武器阶/兵种解锁/调资源/改昵称/设管理员
  - 参数面板：列出 game_params，可编辑保存

- [ ] **Step 1: AdminPage 组件**（表格 + 编辑控件 + 参数面板，用 .card/.mg-* 类）

- [ ] **Step 2: App 路由**（管理员进后台）

- [ ] **Step 3: 构建 + 测试 + Commit**

```bash
git add frontend/src/AdminPage.tsx frontend/src/App.tsx frontend/src/world.css frontend/src/theme.css
git commit -m "feat: 后台管理页面"
```

---

## Self-Review

**Spec 覆盖：** is_admin/game_params/schema+RPC（Task1）、数据层+入口（Task2）、AdminPage UI（Task3）——覆盖。
**Placeholder 扫描：** 无 TBD。
**类型一致性：** admin 函数签名 Task2 定义、Task3 消费一致；RPC 参数名 p_ 前后一致。
