# 免战期新手保护实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyGame 添加免战期新手保护（ADR-0003）：新玩家注册后 24h 内不可被 PvP 挑战，保护其发育。

**Architecture:** `progression` 表加 `peace_protection_until` 列；种子触发器给新用户设 24h；`resolve_pvp` RPC 挑战前校验被挑战者免战期；前端展示免战状态。

**Tech Stack:** React 18 + Vite + TS、Supabase Postgres + RLS + RPC、现有 data.ts 模式。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：军团/挑战/免战期
- 免战期：新用户 24h（从注册起），期间 `resolve_pvp` 拒绝挑战该玩家
- 免战期字段存 `progression.peace_protection_until`（每玩家一行）
- 种子触发器 `seed_new_user` 给新用户设 24h
- resolve_pvp 挑战前校验（服务器权威，防止绕过）
- 中文注释；2 空格；遵循 data.ts/Schema 模式；复用前端测试基建

---

### Task 1: schema（免战期列 + 种子 + resolve_pvp 校验）

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces:
  - `progression` 表新增 `peace_protection_until timestamptz` 列（对已有库用 `ALTER TABLE progression ADD COLUMN IF NOT EXISTS peace_protection_until timestamptz;`）
  - `seed_new_user` 插入 progression 时设 `peace_protection_until = now() + interval '24 hours'`
  - `resolve_pvp` 挑战前：`IF v_tg_protection > now() THEN RAISE EXCEPTION '对方处于免战期'`

- [ ] **Step 1: 修改 schema.sql**

在 `progression` 表定义加 `peace_protection_until timestamptz`；`seed_new_user` 的 progression INSERT 加该列（24h）；`resolve_pvp` 加免战校验。

- [ ] **Step 2: 静态校验 SQL**

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: 免战期新手保护 schema + RPC 校验"
```

---

### Task 2: 数据层 + UI（展示免战状态）

**Files:**
- Modify: `frontend/src/data.ts`、`frontend/src/RightColumn.tsx`、`frontend/src/WorldView.tsx`
- Test: `frontend/test/data.test.ts`

**Interfaces:**
- Consumes: `progression` 表、WorldView 数据
- Produces:
  - `export async function fetchProtection(userId, client?): Promise<{ peaceProtectionUntil: string | null }>`（读 progression）
  - UI 显示"免战期剩余 X 时间"（若有）

- [ ] **Step 1: 数据层 fetchProtection + 测试**

TDD：mock client 读 progression 的 peace_protection_until。

- [ ] **Step 2: UI 展示**

WorldView 拉取并在合适处（右栏/顶部）显示免战剩余时间。

- [ ] **Step 3: 构建 + 测试 + Commit**

```bash
git add frontend/src/data.ts frontend/src/RightColumn.tsx frontend/src/WorldView.tsx frontend/test/data.test.ts
git commit -m "feat: 免战期状态展示"
```

---

## Self-Review

**Spec 覆盖：** 免战期列（Task1）、种子设置（Task1）、resolve_pvp 校验（Task1）、状态展示（Task2）——全部覆盖。
**Placeholder 扫描：** 无 TBD。
**类型一致性：** fetchProtection 返回类型 Task2 定义、UI 消费一致。
