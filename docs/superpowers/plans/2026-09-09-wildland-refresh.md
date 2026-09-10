# 野地刷新系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复野地永久耗尽缺陷：攻破的野地在刷新窗口（WILDLAND_REFRESH_MS=5 分钟）后重新出现，使打野 PvE 循环可持续。

**Architecture:** 新增 SECURITY DEFINER RPC `refresh_wildlands()` 重置过期野地（defeated_at 早于刷新窗口 → 置 NULL）；数据层在 fetchWorld 前调用。服务器权威绕过 RLS（客户端无权重置野地）。

**Tech Stack:** React 18 + Vite + TS、Supabase Postgres + RLS + RPC、现有 data.ts 模式。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：野地/打野/战报
- 刷新窗口 = `WILDLAND_REFRESH_MS` = 5 分钟（与 shared/combat.ts 常量一致）
- 刷新必须服务器权威（SECURITY DEFINER RPC），客户端 RLS 无权重置野地
- `refresh_wildlands()` 幂等：仅重置 defeated_at < now()-5min 的野地，置 defeated_at=NULL
- 中文注释；2 空格；遵循 data.ts/Schema 模式；复用前端测试基建

---

### Task 1: refresh_wildlands RPC + 数据层调用

**Files:**
- Modify: `supabase/schema.sql`、`frontend/src/data.ts`
- Test: `frontend/test/data.test.ts`

**Interfaces:**
- Produces:
  - `refresh_wildlands() RETURNS void` SECURITY DEFINER（重置过期野地）
  - `export async function refreshWildlands(worldId, client?): Promise<void>`（调 RPC `refresh_wildlands`，传 world_id）

- [ ] **Step 1: schema 加 refresh_wildlands 函数**

```sql
CREATE OR REPLACE FUNCTION refresh_wildlands(p_world_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE wildlands
  SET defeated_at = NULL
  WHERE world_id = p_world_id
    AND defeated_at IS NOT NULL
    AND defeated_at < now() - interval '5 minutes';
END;
$$;
```

（刷新窗口 5 分钟，与 shared WILDLAND_REFRESH_MS=300000ms 一致。）

- [ ] **Step 2: data.ts 加 refreshWildlands**

```ts
export async function refreshWildlands(worldId: string, client: SupabaseClient = supabase): Promise<void> {
  const { error } = await client.rpc('refresh_wildlands', { p_world_id: worldId });
  if (error) throw new Error(`刷新野地失败：${error.message}`);
}
```

（注：RPC 参数名以 schema 定义为准 `p_world_id`。）

- [ ] **Step 3: 在 fetchWorld 前调用（WorldView 或 fetchWorld 内部）**

建议在 `fetchWorld` 开头调用 `refreshWildlands(worldId)`（或由 WorldView 在刷新前调用），使攻破 5 分钟后的野地重新出现。选择并实现（优先 fetchWorld 内部，保证每次拉世界都刷新）。

- [ ] **Step 4: TDD 测试 + 构建**

测试 refreshWildlands 调 RPC 且参数 p_world_id 正确。`npm test -w @mygame/frontend` + `npm run build`。

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql frontend/src/data.ts frontend/test/data.test.ts
git commit -m "feat: 野地刷新（攻破 5 分钟后重现）"
```

---

## Self-Review

**Spec 覆盖：** refresh_wildlands RPC（Task1）、数据层调用 + fetchWorld 集成（Task1）——覆盖。
**Placeholder 扫描：** 无 TBD。
**类型一致性：** refreshWildlands 签名 Task1 定义、调用处一致；RPC 参数名与 schema 一致。
