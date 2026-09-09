# 挑战（1v1 PvP）系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyGame 添加挑战（1v1 PvP）：玩家可挑战地图上可见的其他玩家部队，服务器权威（Postgres RPC）结算战斗并把双方战损原子落库。

**Architecture:** 客户端只发起挑战（调 RPC `resolve_pvp(challenger_general_id, target_general_id)`），战斗结算与双方 army_units 战损在 Postgres SECURITY DEFINER 函数内完成（绕过 RLS 写入双方部队，保证 PvP 公平）。战斗公式移植自 `shared/combat.ts`（战力比/胜率/胜轻损败重损）。挑战结果写入 battle_instances/battle_reports 供双方查看。

**Tech Stack:** React 18 + Vite + TS（前端）、Supabase Postgres + RLS + SECURITY DEFINER RPC、shared/ 类型。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：武将/兵/部队/战斗实例/战报/战力/挑战
- PvP 结算必须在 Postgres SECURITY DEFINER 函数内（客户端不可改他人部队，RLS 兜底）
- 战斗公式与 `shared/combat.ts` 一致（战力=武将加成×兵数×单兵战力+武器加成；胜率 logistic；胜方 15% 轻损、败方 70% 重损）
- 挑战对象 = 地图上可见的其他玩家武将（RLS 已开放 generals SELECT）
- 战报写入双方（battle_reports 各自 user_id 一行）
- 中文注释；2 空格；遵循 data.ts/Schema 模式；复用前端测试基建

---

### Task 1: schema（challenges 表 + RLS）+ 单兵战力数据落库

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `challenges` 表（记录挑战发起/结果）+ RLS；兵种单兵战力表（供 RPC 查）

- [ ] **Step 1: 新增 challenges 表 + RLS**

```sql
CREATE TABLE challenges (
  id text PRIMARY KEY,
  challenger_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenger_general_id text REFERENCES generals(id),
  target_general_id text REFERENCES generals(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  result text CHECK (result IN ('challenger_win','challenger_lose','draw')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
-- 双方（挑战者/被挑战者）可读自己的挑战；发起者写；结算由 RPC（SECURITY DEFINER）写
CREATE POLICY challenges_select ON challenges
  FOR SELECT USING (auth.uid() IN (challenger_user_id, target_user_id));
CREATE POLICY challenges_insert ON challenges
  FOR INSERT WITH CHECK (auth.uid() = challenger_user_id);
```

- [ ] **Step 2: 兵种战力表（供 RPC 计算）**

RPC 需查兵种单兵战力（1-15 级）。建 `troop_stats(soldier_level int PK, power int)` 表，插入与 `shared/troops.ts` TROOP_CATALOG 一致的单兵战力（乡勇=10…混沌主宰按 shared 值）。供 SECURITY DEFINER RPC 使用。

- [ ] **Step 3: 静态校验 + Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: challenges 表 + 兵种战力数据"
```

---

### Task 2: resolve_pvp RPC（服务器权威战斗结算）

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `resolve_pvp(challenger_general_id text, target_general_id text) RETURNS jsonb` SECURITY DEFINER 函数
  - 读取双方 general（level/stars/weapon tier）+ army_units（count per soldier_level）
  - 用 troop_stats 算单兵战力、armyPower、generalSidePower（复用 shared 公式）
  - 用 winProbability 决定胜负（可用简单确定性：战力高者胜 + 小额随机，或种子随机）
  - 按胜负率套用战损（胜 15%/败 70%），UPDATE 双方 army_units
  - 写 battle_instances + 双方 battle_reports
  - 更新 challenges.status='resolved' + result
  - 返回 result jsonb（双方战力、战损、胜者）

- [ ] **Step 1: 写 resolve_pvp 函数（PL/pgSQL，移植 combat 公式）**

用 PL/pgSQL 实现战力比与战损（与 shared/combat.ts 公式一致），SECURITY DEFINER 以函数所有者身份绕过 RLS 更新双方 army_units。

- [ ] **Step 2: 静态校验（括号/引号闭合，函数逻辑自检）**

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: resolve_pvp 服务器权威战斗 RPC"
```

---

### Task 3: 数据层（发起挑战/查询）

**Files:**
- Modify: `frontend/src/data.ts`
- Test: `frontend/test/data.test.ts`

**Interfaces:**
- Consumes: supabase client、shared 类型
- Produces:
  - `export interface Challenge { id; challengerUserId; targetUserId; status; result; createdAt }`
  - `export async function initiateChallenge(userId, challengerGeneralId, targetGeneralId, client?): Promise<void>`（插入 challenges + 调 RPC `resolve_pvp`）
  - `export async function fetchChallenges(userId, client?): Promise<Challenge[]>`（读自己相关）
  - RPC 调用：`client.rpc('resolve_pvp', { challenger_general_id, target_general_id })`

- [ ] **Step 1: 写失败测试**（mock client 验证 initiateChallenge 插 challenges + 调 rpc；fetchChallenges 读自己的）

- [ ] **Step 2: 运行测试失败 → 实现 → 通过**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/data.ts frontend/test/data.test.ts
git commit -m "feat: 挑战数据层"
```

---

### Task 4: 挑战 UI（地图上挑战其他玩家 + 结果）

**Files:**
- Modify: `frontend/src/WorldView.tsx`、`frontend/src/MapBoard.tsx`、`frontend/src/RightColumn.tsx`

**Interfaces:**
- Consumes: data.ts 的 initiateChallenge/fetchChallenges、WorldView 的敌武将（side='enemy'）
- Produces: 选中敌方部队 → "挑战"按钮；挑战结果在战报/挑战列表显示

- [ ] **Step 1: 地图上敌方部队可选中 → "挑战"按钮**

MapBoard/WorldView：选中敌方（side='enemy'）武将时显示"挑战"，点调用 initiateChallenge。

- [ ] **Step 2: 挑战结果显示**

挑战结果（战报 + 双方战力/战损）在战报卡显示。

- [ ] **Step 3: 构建验证 + Commit**

```bash
git add frontend/src/WorldView.tsx frontend/src/MapBoard.tsx frontend/src/RightColumn.tsx
git commit -m "feat: 挑战 UI"
```

---

## Self-Review

**Spec 覆盖：** challenges schema（Task1）、resolve_pvp RPC（Task2）、数据层（Task3）、UI（Task4）——全部覆盖。
**Placeholder 扫描：** 无 TBD。
**类型一致性：** Challenge 接口 Task3 定义、Task4 消费；resolve_pvp 参数名 Task2 定义、Task3 RPC 调用一致。
