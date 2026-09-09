# 军团系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyGame 添加军团（社交层）：创建/加入/退出军团、查看成员，替换右栏"敬请期待"占位。

**Architecture:** 服务端 schema（guilds/guild_members + RLS）+ 前端数据层（createGuild/joinGuild/leaveGuild/fetchMyGuild/fetchGuilds）+ 右栏军团卡 UI。保持无服务器架构。

**Tech Stack:** React 18 + Vite + TS（前端）、Supabase Postgres + RLS、现有 data.ts 模式。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：军团
- 遵循现有 data.ts 模式（Supabase client 注入 + 中文 Error + 中文注释 + 2 空格）
- RLS：guilds 登录可读、创建任意用户、改删仅 leader；guild_members 登录可读、加入/退出仅本人
- 新用户默认无军团（不加入种子）
- 复用前端测试基建（mock supabase client）
- 沿用 ADR-0004（无服务器客户端架构），军团为纯社交层，无 PvP 战斗

---

### Task 1: schema（guilds/guild_members + RLS）

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `guilds`、`guild_members` 表 + RLS 策略（供 data 层使用）

- [ ] **Step 1: 在 schema.sql 末尾（第 15 段之后）新增表**

```sql
-- =============================================================
-- 16. 军团（社交层）：创建/加入/退出，无 PvP 战斗
-- =============================================================
CREATE TABLE guilds (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  leader_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guild_members (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

ALTER TABLE guilds ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_members ENABLE ROW LEVEL SECURITY;

-- guilds：登录用户可读全部；创建任意登录用户；改名/解散仅 leader
CREATE POLICY guilds_select ON guilds FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY guilds_insert ON guilds FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY guilds_update ON guilds
  FOR UPDATE USING (auth.uid() = leader_user_id) WITH CHECK (auth.uid() = leader_user_id);
CREATE POLICY guilds_delete ON guilds
  FOR DELETE USING (auth.uid() = leader_user_id);

-- guild_members：登录用户可读全部；加入/退出仅本人
CREATE POLICY guild_members_select ON guild_members
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY guild_members_insert ON guild_members
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY guild_members_delete ON guild_members
  FOR DELETE USING (auth.uid() = user_id);
```

- [ ] **Step 2: 静态校验 SQL（括号/引号闭合）**

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: 军团 schema + RLS"
```

---

### Task 2: 数据层（guild 读写）

**Files:**
- Modify: `frontend/src/data.ts`
- Test: `frontend/test/data.test.ts`

**Interfaces:**
- Consumes: `supabase` client、`SupabaseClient` 注入模式
- Produces:
  - `export interface Guild { id: string; name: string; leaderUserId: string; createdAt: string }`
  - `export interface GuildMember { guildId: string; userId: string; joinedAt: string }`
  - `export async function fetchGuilds(client?): Promise<Guild[]>`
  - `export async function fetchMyGuild(userId, client?): Promise<Guild | null>`（通过 guild_members 查所属）
  - `export async function fetchGuildMembers(guildId, client?): Promise<GuildMember[]>`
  - `export async function createGuild(userId, name, client?): Promise<Guild>`
  - `export async function joinGuild(userId, guildId, client?): Promise<void>`
  - `export async function leaveGuild(userId, guildId, client?): Promise<void>`
  - 表名/列名与 schema.sql 一致；中文 Error

- [ ] **Step 1: 写失败测试** `frontend/test/data.test.ts`

用 makeFakeSupabase 模拟，验证：createGuild 插入 guilds + 本人加入 guild_members；joinGuild 插入 guild_members；leaveGuild 删除本人 guild_members 行；fetchMyGuild 通过 guild_members 反查 guild；fetchGuilds 列出全部。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -w @mygame/frontend` Expected: FAIL（guild 函数不存在）

- [ ] **Step 3: 实现 data.ts 的 guild 函数**

沿用现有模式（`client.from('guilds')` 等），表/列名匹配 schema.sql。

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -w @mygame/frontend` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data.ts frontend/test/data.test.ts
git commit -m "feat: 军团数据层"
```

---

### Task 3: 军团卡 UI（替换右栏占位）

**Files:**
- Modify: `frontend/src/RightColumn.tsx`、`frontend/src/WorldView.tsx`

**Interfaces:**
- Consumes: data.ts 的 guild 函数、WorldView 已有数据
- Produces: 右栏军团卡功能化

- [ ] **Step 1: 改造 RightColumn**

军团卡改为：
- 无军团：显示"创建军团"（输入名字 + 按钮）、"加入军团"（列出可加入军团 + 加入按钮）
- 有军团：显示军团名 + 成员列表 + "退出军团"按钮
- 操作调用通过 props 传入的 callbacks（由 WorldView 实现，内部调 data.ts）

- [ ] **Step 2: WorldView 提供数据与操作**

WorldView 用 fetchMyGuild/fetchGuilds/fetchGuildMembers 加载，提供 createGuild/joinGuild/leaveGuild 的 callbacks，传入 RightColumn。

- [ ] **Step 3: 构建验证**

Run: `npm run build` Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add frontend/src/RightColumn.tsx frontend/src/WorldView.tsx
git commit -m "feat: 军团卡 UI"
```

---

## Self-Review

**Spec 覆盖：** 军团 schema+RLS（Task1）、数据层（Task2）、UI（Task3）——全部覆盖。
**Placeholder 扫描：** 无 TBD。
**类型一致性：** Guild/GuildMember 接口在 Task2 定义、Task3 消费一致；表名/列名与 schema.sql 一致。
