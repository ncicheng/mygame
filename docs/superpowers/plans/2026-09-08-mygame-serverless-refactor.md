# MyGame 无服务器重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MyGame 从"自建 Node 后端 + 服务器权威"重构为"前端计算 + Supabase 存储"的无服务器架构，并做全界面酷炫 UI + 版权标识。

**Architecture:** 前端 React 直连 Supabase（Auth + Postgres），游戏逻辑复用 `shared/` 纯函数在前端本地结算，去掉 `backend/`、Socket.IO、服务器 ticker。前端仍部署 GitHub Pages。

**Tech Stack:** React 18 + Vite + TS（前端）、`@supabase/supabase-js`（数据/Auth）、Supabase Postgres（含 RLS）、`shared/`（纯逻辑，已存在）。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：武将/兵/部队/武器/大地图/战斗实例/对战模式/军团/城池/养成/行动点/战力
- 游戏核心逻辑（战斗/行军/招募/养成）全部复用 `shared/` 现有纯函数，不得在组件里重写算法
- 数据经 Supabase anon key 直连，**每一张表必须启用 RLS**（owner 隔离；`worlds`/`world_tiles` 登录用户可读）
- 移除 `backend/` 目录与 Socket.IO；ADR-0002 标记 deprecated
- 所有界面（含登录/注册）需酷炫化视觉（动效/渐变/光效，契合仙侠三国主题）
- 所有界面底部标注 **`Powered By 杨子轩@五年级`**
- 前端构建仍输出到 GitHub Pages；`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` 由构建时注入（GitHub variable）
- 中文注释；2 空格缩进

## 文件结构（本次改动）

- `frontend/src/supabase.ts` — 新建：Supabase 客户端初始化（读 env）
- `frontend/src/auth.ts` — 新建：认证封装（Supabase Auth：注册/登录/登出/取当前用户）
- `frontend/src/data.ts` — 新建：数据访问层（Supabase 读写：资源/武将/部队/行军/战斗/养成）
- `frontend/src/game.ts` — 新建：本地结算编排（调 shared 纯逻辑 + data.ts 读写）
- `frontend/src/api.ts` / `realtime.ts` — 删除
- `frontend/src/*.tsx` — 修改：组件改用 data/auth/game，并做酷炫 UI + 版权
- `frontend/src/theme.css` — 新建：酷炫主题（渐变/动效/光效）
- `supabase/schema.sql` — 新建：完整 schema + RLS 策略
- `render.yaml` — 删除
- `.github/workflows/deploy.yml` — 修改：注入 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
- `docs/adr/0002-*.md` — 修改：标记 deprecated；新增无服务器 ADR

---

### Task 1: Supabase schema + RLS

**Files:**
- Create: `supabase/schema.sql`

**Interfaces:**
- Consumes: `backend/src/schema.ts` 的表结构（users/sessions/resources/weapons/worlds/world_tiles/cities/wildlands/generals/progression/army_units/action_points/marches/battle_instances/battle_reports）
- Produces: `supabase/schema.sql`（DDL + RLS 策略），供用户在 Supabase Studio 执行

- [ ] **Step 1: 阅读现有 schema**

读 `backend/src/schema.ts` 全部 `CREATE TABLE IF NOT EXISTS` 语句，逐表提取列定义、约束（唯一约束、外键）、迁移补丁（army_units 唯一、wildlands 掉落/刷新列、generals 星级、cities 坐标唯一、weapons.general_id 外键）。

- [ ] **Step 2: 编写 Supabase schema.sql**

新建 `supabase/schema.sql`，含：
- 全部建表语句（保留原列名/类型/约束）
- 删除 `sessions` 表（Supabase Auth 自己管理会话）——或保留但不用
- 每张表启用 RLS：`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
- RLS 策略：
  - `users`、`resources`、`weapons`、`generals`、`army_units`、`action_points`、`progression`、`cities`（玩家自己的）、`marches`、`battle_instances`、`battle_reports`：`auth.uid()` 关联 owner 列，`SELECT/INSERT/UPDATE/DELETE` 仅限自己的行。这些表需一个 `user_id`（或 `owner_user_id`）列关联 `auth.uid()`；原 schema 若用 `user_id` 已兼容，否则加列。
  - `worlds`、`world_tiles`：所有登录用户可 `SELECT`（`USING (auth.uid() IS NOT NULL)`），不可写
  - `wildlands`：登录用户可读；攻打后 `UPDATE` 需校验归属（玩家可更新自己触发的战斗结果）
- 在文件顶部注释：执行方式（Supabase Studio → SQL Editor 粘贴执行）

- [ ] **Step 3: 静态校验 SQL 语法**

本机若有 `psql`/postgres 则用 embedded-postgres 校验；否则人工检查括号/引号闭合。运行：`node scripts/run-integration.mjs`（沿用现有）若依赖原库则跳过——本任务只产出 SQL 文件，不做代码测试。将 SQL 交由用户最终在 Supabase Studio 执行（见 Task 8 的 wizard）。

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: Supabase schema + RLS 策略"
```

---

### Task 2: Supabase 客户端 + 认证封装

**Files:**
- Create: `frontend/src/supabase.ts`
- Create: `frontend/src/auth.ts`
- Modify: `frontend/package.json`（加 `@supabase/supabase-js`）
- Modify: `frontend/.env.example`

**Interfaces:**
- Consumes: `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` 环境变量
- Produces:
  - `supabase.ts`: `export const supabase: SupabaseClient`
  - `auth.ts`:
    - `export async function signUp(email, password): Promise<void>`
    - `export async function signIn(email, password): Promise<void>`
    - `export async function signOut(): Promise<void>`
    - `export async function getCurrentUser(): Promise<User | null>`
    - `export function onAuthChange(cb): unsubscribe`

- [ ] **Step 1: 写失败测试** `frontend/test/auth.test.ts`

```ts
// 模拟 supabase 客户端，验证 auth.ts 封装透传正确
// signUp 调用 supabase.auth.signUp; signIn 调用 supabase.auth.signInWithPassword; 等
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -w @mygame/frontend`
Expected: FAIL（auth.ts 不存在）

- [ ] **Step 3: 安装依赖 + 实现**

```bash
npm install -w @mygame/frontend @supabase/supabase-js
```

`supabase.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
const url = (import.meta as any).env?.VITE_SUPABASE_URL ?? '';
const anon = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? '';
export const supabase: SupabaseClient = createClient(url, anon);
```

`auth.ts`：封装 `signUp/signIn/signOut/getCurrentUser/onAuthChange`，透传 supabase.auth。

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -w @mygame/frontend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/supabase.ts frontend/src/auth.ts frontend/package.json frontend/package-lock.json frontend/.env.example frontend/test/auth.test.ts
git commit -m "feat: Supabase 客户端与认证封装"
```

---

### Task 3: 数据访问层（Supabase 读写）

**Files:**
- Create: `frontend/src/data.ts`

**Interfaces:**
- Consumes: `supabase`（Task 2）、`shared/` 类型（Resources/Weapon/General/WorldStateResponse/MarchStatus/BattleReport 等）
- Produces（供 game.ts 与组件调用）：
  - `fetchWorld(userId): Promise<WorldStateResponse>`
  - `fetchResources(userId)`, `updateResources(userId, delta)`
  - `fetchGeneral(userId)`, `fetchArmyUnits(generalId)`
  - `createMarch(generalId, targetX, targetY, ...)`, `cancelMarch(marchId)`
  - `saveBattleResult(generalId, result: CombatResult, report)`
  - `unlockTroop(userId, level)`, `levelUpGeneral`, `starUpGeneral`, `upgradeWeapon`
  - 各函数内部用 `supabase.from(...)` 查询，配合 RLS

- [ ] **Step 1: 写失败测试** `frontend/test/data.test.ts`

用 mock 的 supabase client 验证：fetchWorld 组装正确行、createMarch 写入 marches 表、saveBattleResult 写 battle_reports 并更新资源稀有材料等。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -w @mygame/frontend` Expected: FAIL

- [ ] **Step 3: 实现 data.ts**

用 `supabase.from(table)` 完成各读写。表名/列名与 `supabase/schema.sql` 一致。所有写操作走事务性（`supabase.rpc` 或顺序更新；Supabase 前端无事务，写错就报错回滚到组件层）。关键：任何 `UPDATE`/`DELETE` 都带 `auth.uid()` 过滤，依赖 RLS 兜底。

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -w @mygame/frontend` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data.ts frontend/test/data.test.ts
git commit -m "feat: Supabase 数据访问层"
```

---

### Task 4: 本地结算编排

**Files:**
- Create: `frontend/src/game.ts`

**Interfaces:**
- Consumes: `data.ts`（Task 3）、`shared/combat.ts`（resolveCombat/marchPositionAt 相关纯函数）、`shared/troops.ts`、`shared/weapons.ts`、`shared/progression.ts`
- Produces:
  - `settleBattle(generalId, defender: CombatSideInput): Promise<CombatResult>` — 调 `resolveCombat` 得结果，再 `data.saveBattleResult`
  - `computeMarchPosition(march, now): {x,y}` — 本地按 `MARCH_TILE_MS`/曼哈顿距离插值
  - `applyTroopLosses(army, result)`, `grantWildlandDrop(...)`
  - `recruitTroop(...)`, `unlockTroop/levelUp/starUp/upgradeWeapon` 编排

- [ ] **Step 1: 写失败测试** `frontend/test/game.test.ts`

模拟：settleBattle 调 resolveCombat 且把结果写库（mock data.ts）；computeMarchPosition 用固定 march + 时间断言插值坐标；recruitTroop 扣资源 + 加兵。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -w @mygame/frontend` Expected: FAIL

- [ ] **Step 3: 实现 game.ts**

编排层：从组件接收输入 → 调 shared 纯函数计算 → 调 data.ts 持久化。保持纯函数逻辑在 shared，game.ts 只做"取数据→计算→写回"。

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -w @mygame/frontend` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/game.ts frontend/test/game.test.ts
git commit -m "feat: 本地结算编排层"
```

---

### Task 5: 组件接入（去后端化）

**Files:**
- Modify: `frontend/src/App.tsx`、`AuthForm.tsx`、`WorldView.tsx`、`ActionDeck.tsx`、`LeftColumn.tsx`、`RightColumn.tsx`、`MapBoard.tsx`、`RecruitModal.tsx`、`BattleOverlay.tsx`
- Delete: `frontend/src/api.ts`、`frontend/src/realtime.ts`

**Interfaces:**
- Consumes: `auth.ts`（Task 2）、`data.ts`（Task 3）、`game.ts`（Task 4）
- Produces: 各组件不再调 `/api/*`，改用 auth/data/game

- [ ] **Step 1: 改造 App.tsx 认证流**

删除对 api.ts 的注册/登录调用，改用 `auth.signUp/signIn/signOut/onAuthChange`；token 管理移除（Supabase 自己管），用 `getCurrentUser()`。

- [ ] **Step 2: 改造 WorldView 数据源**

把 `apiWorld(token)`/`/api/world` 拉取换成 `data.fetchWorld(userId)`；移除 Socket.IO 订阅（realtime.ts），改为组件内定时 `setInterval` 调 `fetchWorld` 刷新（或本地 `computeMarchPosition`）。删除 realtime.ts。

- [ ] **Step 3: 改造动作（行军/招募/打野/养成）**

ActionDeck 的出征/招募/打野、RecruitModal、BattleOverlay、养成按钮全部改调 `game.ts` 编排 + `data.ts`。

- [ ] **Step 4: 删除 api.ts/realtime.ts，清理未用导入**

确认无组件再引用后删除；`socket.io-client` 从 package.json 移除（`npm uninstall -w @mygame/frontend socket.io-client`）。

- [ ] **Step 5: 全量构建 + 测试**

Run: `npm run build && npm test`
Expected: 全绿，无残留 `/api` 引用。可用 `grep -rn "/api" frontend/src` 确认干净。

- [ ] **Step 6: Commit**

```bash
git add -A frontend
git commit -m "refactor: 组件改走 Supabase，移除后端 API/Socket.IO"
```

---

### Task 6: 全界面酷炫 UI + 版权标识

**Files:**
- Create: `frontend/src/theme.css`
- Modify: `frontend/src/App.tsx`、`AuthForm.tsx`、`WorldView.tsx`、`ActionDeck.tsx`、`LeftColumn.tsx`、`RightColumn.tsx`、`MapBoard.tsx`、`RecruitModal.tsx`、`BattleOverlay.tsx`、`index.css`

**Interfaces:**
- Produces: 统一主题类（`.mg-gradient`、`.mg-glow`、`.mg-card`、`.mg-btn` 等），各组件引入并美化

- [ ] **Step 1: 编写 theme.css 主题系统**

定义：
- 渐变背景（深色→青/金，仙侠风）
- 卡片光效（`.mg-card`：毛玻璃 + 光晕）
- 按钮动效（`.mg-btn`：hover 缩放/发光）
- 入场/淡入动画、粒子/光晕装饰
- 登录页专属动态背景（星空/水墨粒子）

- [ ] **Step 2: 美化登录/注册页（AuthForm）**

套用主题，加动画背景 + `Powered By 杨子轩@五年级` 底部标识。

- [ ] **Step 3: 美化主界面各卡/棋盘/弹窗**

MapBoard（棋盘格光效）、卡片栏（毛玻璃）、ActionDeck（按钮动效）、RecruitModal/BattleOverlay（弹窗光效）。均加版权标识。

- [ ] **Step 4: 提取版权标识组件**

在 `App.tsx` 或独立组件统一渲染 `<footer>Powered By 杨子轩@五年级</footer>`，各界面复用。

- [ ] **Step 5: 构建验证**

Run: `npm run build` Expected: 通过。无视觉断言（人工验收）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/theme.css frontend/src/*.tsx frontend/src/index.css
git commit -m "feat: 全界面酷炫 UI + Powered By 版权标识"
```

---

### Task 7: 清理后端 + 更新文档/部署

**Files:**
- Delete: `backend/`（整个目录）
- Delete: `render.yaml`
- Modify: `.github/workflows/deploy.yml`（注入 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`）
- Modify: `docs/adr/0002-server-authoritative-node-backend.md`（标记 deprecated）
- Create: `docs/adr/0004-serverless-frontend-supabase.md`
- Modify: `README.md`（新部署说明）

**Interfaces:**
- Produces: 无后端依赖的构建管道；ADR 更新

- [ ] **Step 1: 删除 backend/ 与 render.yaml**

```bash
git rm -r backend render.yaml
```

确认 `npm run build` 不再引用 backend（根 package.json workspaces 移除 backend）。

- [ ] **Step 2: 更新根 package.json**

从 workspaces 移除 `backend`；移除相关脚本。

- [ ] **Step 3: 更新 deploy.yml**

构建步骤注入：
```yaml
env:
  VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
  VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}
```

- [ ] **Step 4: 更新 ADR**

`0002` 加 `Status: deprecated（无服务器重构，见 0004）`；新建 `0004` 记录无服务器前端+Supabase 决策。

- [ ] **Step 5: 更新 README**

写新部署：Supabase 建项目 → 执行 schema.sql → 设 GitHub variables → push 到 main 触发 Pages。

- [ ] **Step 6: 构建验证 + Commit**

Run: `npm install && npm run build` Expected: 通过
```bash
git add -A
git commit -m "refactor: 移除后端，更新部署与 ADR"
```

---

### Task 8: 上线配置 wizard

**Files:**
- Create: `scripts/supabase-setup.sh`（wizard，引导用户在 Supabase 建项目、执行 schema、设 GitHub variables）

**Interfaces:**
- Produces: 可运行的 setup 脚本，带用户完成 Supabase 配置

- [ ] **Step 1: 编写 wizard 脚本**

基于 wizard 模板，阶段：
1. 登录/创建 Supabase（supabase.com）
2. New project（免费）→ 拿 Project URL 与 anon key
3. SQL Editor 执行 `supabase/schema.sql`（或贴内容）
4. 设 GitHub Actions variables：`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`（提示 token 权限不足时网页手动设）
5. 提示 push 到 main 触发前端重新部署

- [ ] **Step 2: 校验脚本**

Run: `bash -n scripts/supabase-setup.sh` Expected: 无语法错误；chmod +x。

- [ ] **Step 3: Commit**

```bash
git add scripts/supabase-setup.sh
git commit -m "feat: Supabase 上线配置 wizard"
```

---

### Task 9: 端到端验证（用户执行）

- [ ] **Step 1: 运行 wizard**

用户运行 `bash scripts/supabase-setup.sh`，完成 Supabase 配置。

- [ ] **Step 2: 触发前端部署**

push 到 main → GitHub Actions 构建 → Pages 部署。

- [ ] **Step 3: 线上验收**

打开 Pages URL，注册/登录、打野、行军、养成走一遍，确认数据写入 Supabase、UI 酷炫、版权标识可见。

---

## Self-Review

**Spec 覆盖：**
- 前端算 + Supabase 存 → Task 2/3/4/5 ✓
- 移除 backend/Socket.IO → Task 7 ✓
- RLS → Task 1 ✓
- 酷炫 UI + 版权 → Task 6 ✓
- ADR 更新 → Task 7 ✓
- 部署（GitHub Pages + Supabase variables）→ Task 7/8/9 ✓

**Placeholder 扫描：** 无 TBD/TODO；各 Step 含具体代码/命令。Task 1/3 的 SQL 与 data 层表名需在实现时对照 `schema.sql` 精确填写（Schema 一次性由 schema.ts 迁移，计划指向该文件）。Task 6 UI 无自动化断言（视觉人工验收），已在步骤注明。

**类型一致性：** auth.ts/data.ts/game.ts 的导出签名在 Task 2/3/4 中一致，Task 5 组件按这些签名调用。
