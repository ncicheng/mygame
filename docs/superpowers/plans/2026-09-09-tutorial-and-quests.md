# 新手引导 + 任务目标系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyGame 添加派生式任务目标系统与首次登录新手引导，并完善加载/错误屏版权页脚、军团占位、野地高亮等细节，让玩家明确"下一步该做什么"。

**Architecture:** 任务进度从现有游戏状态（fetchWorld/fetchReports/fetchResources/fetchGeneral/fetchTroopMaxUnlocked/fetchArmyUnits）实时派生，无新 schema/RLS。新手引导为前端覆盖层，首次登录用 localStorage 标记触发一次，可跳过。全部纯前端，无后端改动。

**Tech Stack:** React 18 + Vite + TS（前端），现有 shared/ 纯类型与数据层。

## Global Constraints

- 领域词汇用 `CONTEXT.md`：武将/兵/部队/武器/大地图/战斗实例/野地/战报/稀有材料/养成/行动点/军团/城池
- 任务进度**派生**自现有游戏状态，**不加数据库表、不加 RLS、不改后端**
- 新手引导首次登录触发一次（localStorage 标记 `mygame_tutorial_done`），可跳过
- 所有界面（含加载/错误屏）保留 `Powered By 杨子轩@五年级` 版权页脚
- 中文注释；2 空格缩进；遵循现有组件/数据层模式
- 复用现有前端测试基建（node:test + mock supabase client 注入）

---

### Task 1: 任务进度派生逻辑（纯函数）

**Files:**
- Create: `frontend/src/quests.ts`
- Test: `frontend/test/quests.test.ts`

**Interfaces:**
- Consumes: `WorldStateResponse`、`BattleReport`、`Resources`、`General`、`Soldier[]`、`troopMaxUnlocked`（均来自 data.ts / shared 类型）
- Produces:
  - `export interface Quest { id: string; title: string; done: boolean; hint: string }`
  - `export interface QuestState { quests: Quest[]; current: Quest | null; allDone: boolean }`
  - `export function computeQuests(input: { reports: BattleReport[]; troops: Soldier[]; weaponTier: number; troopMaxUnlocked: number; generalLevel: number }): QuestState`
  - 完成条件与设计文档表一致（7 个任务）

- [ ] **Step 1: 写失败测试** `frontend/test/quests.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuests } from '../src/quests.js';

function q({ reports = [], troops = [], weaponTier = 1, troopMaxUnlocked = 3, generalLevel = 1 }) {
  return computeQuests({ reports, troops, weaponTier, troopMaxUnlocked, generalLevel });
}

test('空状态下全部任务未完成，current 为第一个任务', () => {
  const s = q({});
  assert.equal(s.quests.length, 7);
  assert.equal(s.current?.id, 'recruit');
  assert.equal(s.allDone, false);
});

test('招募 100 乡勇后任务 1 完成', () => {
  const s = q({ troops: [{ soldierLevel: 1, count: 120, type: '乡勇' }] });
  const r = s.quests.find((x) => x.id === 'recruit')!;
  assert.equal(r.done, true);
});

test('有战报则行军/打野/胜利任务完成', () => {
  const s = q({ reports: [{ id: 'r1', victory: true } as BattleReport] });
  assert.equal(s.quests.find((x) => x.id === 'march')!.done, true);
  assert.equal(s.quests.find((x) => x.id === 'bandit')!.done, true);
  assert.equal(s.quests.find((x) => x.id === 'win')!.done, true);
});

test('武器 2 阶 / 解锁>3 / 武将2级 分别完成对应任务', () => {
  assert.equal(q({ weaponTier: 2 }).quests.find((x) => x.id === 'weapon')!.done, true);
  assert.equal(q({ troopMaxUnlocked: 4 }).quests.find((x) => x.id === 'unlock')!.done, true);
  assert.equal(q({ generalLevel: 2 }).quests.find((x) => x.id === 'level')!.done, true);
});

test('全部完成后 current 为 null、allDone 为 true', () => {
  const s = q({ reports: [{ victory: true } as BattleReport], troops: [{ soldierLevel: 1, count: 100 }], weaponTier: 2, troopMaxUnlocked: 4, generalLevel: 2 });
  assert.equal(s.allDone, true);
  assert.equal(s.current, null);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -w @mygame/frontend -- quests` Expected: FAIL（quests.ts 不存在）

- [ ] **Step 3: 实现 quests.ts**

```ts
import type { BattleReport, Soldier } from '@mygame/shared';

export interface Quest { id: string; title: string; done: boolean; hint: string; }
export interface QuestState { quests: Quest[]; current: Quest | null; allDone: boolean; }
export interface QuestInput {
  reports: BattleReport[];
  troops: Soldier[];
  weaponTier: number;
  troopMaxUnlocked: number;
  generalLevel: number;
}

const DEFS = [
  { id: 'recruit', title: '招募 100 乡勇', hint: '底部操作台 → 招募，用粮草招募乡勇', done: (i: QuestInput) => (i.troops.find((t) => t.soldierLevel === 1)?.count ?? 0) >= 100 },
  { id: 'march', title: '发起一次行军', hint: '选中我方武将 → 点地图目标格下达行军', done: (i: QuestInput) => i.reports.length >= 1 || i.troops.length >= 1 },
  { id: 'bandit', title: '首次攻打野地', hint: '选中武将 → 点野地 → 打野', done: (i: QuestInput) => i.reports.length >= 1 },
  { id: 'win', title: '首次打野胜利', hint: '打野胜利后战报显示 🏆', done: (i: QuestInput) => i.reports.some((r) => r.victory) },
  { id: 'weapon', title: '强化武器到 2 阶', hint: '左栏养成卡 → 武器强化（耗稀有材料）', done: (i: QuestInput) => i.weaponTier >= 2 },
  { id: 'unlock', title: '解锁高级兵种', hint: '左栏养成卡 → 兵种解锁', done: (i: QuestInput) => i.troopMaxUnlocked > 3 },
  { id: 'level', title: '升级武将到 2 级', hint: '左栏养成卡 → 武将升级（耗稀有材料）', done: (i: QuestInput) => i.generalLevel >= 2 },
];

export function computeQuests(input: QuestInput): QuestState {
  const quests = DEFS.map((d) => ({ id: d.id, title: d.title, hint: d.hint, done: d.done(input) }));
  const current = quests.find((x) => !x.done) ?? null;
  return { quests, current, allDone: current === null };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -w @mygame/frontend -- quests` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/quests.ts frontend/test/quests.test.ts
git commit -m "feat: 任务进度派生纯函数"
```

---

### Task 2: 任务卡 UI（替换右栏占位）

**Files:**
- Modify: `frontend/src/RightColumn.tsx`、`frontend/src/WorldView.tsx`

**Interfaces:**
- Consumes: `computeQuests`（Task 1）、WorldView 已有数据（reports/troops/weaponTier/troopMaxUnlocked/generalLevel）
- Produces: 右栏"任务"卡显示任务清单 + 当前目标 + 下一步提示；WorldView 传入派生所需数据

- [ ] **Step 1: 读取现有 RightColumn 与 WorldView 数据**

读 `frontend/src/RightColumn.tsx` 与 `WorldView.tsx` 中 reports/general/troops 的持有方式，确认传给 RightColumn 的 props 与 WorldView 已有的 `general`（含 weapon.tier/level）、`troops`（fetchArmyUnits）、`troopMaxUnlocked`、`reports`。

- [ ] **Step 2: 改造 RightColumn**

在 `RightColumnProps` 增加 `quests: QuestState`，把"任务"卡从 `暂无任务` 占位改为渲染 `computeQuests` 结果：
- 顶部显示 `当前目标：<current.title>` + `<current.hint>`
- 任务清单逐条勾选（done → ✅，未完成 → ○）
- 全部完成显示 "🏆 成就达成"
- 军团卡改为 `敬请期待（后续迭代）`

- [ ] **Step 3: WorldView 计算并传入 quests**

在 WorldView 中用 `computeQuests({ reports, troops: general?.army ?? [], weaponTier: general?.weapon?.tier ?? 1, troopMaxUnlocked, generalLevel: general?.level ?? 1 })` 计算，作为 prop 传入 `<RightColumn quests={...} />`。

- [ ] **Step 4: 构建验证**

Run: `npm run build` Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add frontend/src/RightColumn.tsx frontend/src/WorldView.tsx
git commit -m "feat: 任务目标卡 UI"
```

---

### Task 3: 新手引导覆盖层

**Files:**
- Create: `frontend/src/Tutorial.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: 无（自包含覆盖层）；localStorage 键 `mygame_tutorial_done`
- Produces: `Tutorial` 组件（首次登录展示，分步高亮 + 跳过）

- [ ] **Step 1: 实现 Tutorial.tsx**

自包含覆盖层组件：`<Tutorial onClose={() => { localStorage.setItem('mygame_tutorial_done', '1'); }} />`。4 步（操作台/行军/打野/养成），每步一个居中卡片：标题 + 说明 + "下一步"按钮；"跳过引导"按钮直接 onClose。用 theme.css 的 `.mg-*` 类美化，含 `Powered By` 版权页脚。深色半透明遮罩盖住全屏。

- [ ] **Step 2: App.tsx 首次登录展示**

在 `App.tsx` 的 `user !== null` 分支（`<WorldView>` 旁）判断：若 `localStorage.getItem('mygame_tutorial_done')` 为空则渲染 `<Tutorial onClose={...} />`。

- [ ] **Step 3: 构建验证**

Run: `npm run build` Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add frontend/src/Tutorial.tsx frontend/src/App.tsx
git commit -m "feat: 新手引导覆盖层"
```

---

### Task 4: 细节完善（版权页脚 / 野地高亮 / 清理）

**Files:**
- Modify: `frontend/src/App.tsx`（加载/错误屏加版权页脚）、`frontend/src/MapBoard.tsx`（野地发光）、`frontend/src/RightColumn.tsx`（军团占位已改）、根 `package.json`（移除 concurrently）

**Interfaces:**
- Produces: 无新接口，均为完善

- [ ] **Step 1: 加载/错误屏补版权页脚**

在 `App.tsx` 的加载屏（`loading && user===null`）与错误横幅屏外层补 `<CopyrightFooter />`（若无外层布局则加一个含页脚的容器）。

- [ ] **Step 2: 野地发光**

在 `MapBoard.tsx` 的野地（`wildland`）标记上加 `.mg-glow-bandit` 类（轻微发光，CSS 加到 theme.css 或 world.css），引导去打野。

- [ ] **Step 3: 移除 concurrently**

根 `package.json` devDependencies 删 `concurrently`；`npm install` 更新 lock。

- [ ] **Step 4: 构建 + 测试验证**

Run: `npm install && npm run build && npm test -w @mygame/frontend` Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: 细节完善（版权页脚/野地高亮/清理依赖）"
```

---

## Self-Review

**Spec 覆盖：**
- 派生式任务（7 任务）→ Task 1 + Task 2 ✓
- 新手引导覆盖层 + localStorage → Task 3 ✓
- 加载/错误屏版权页脚 → Task 4 ✓
- 军团占位改敬请期待 → Task 2 ✓
- 野地发光 → Task 4 ✓
- 移除 concurrently → Task 4 ✓

**Placeholder 扫描：** 无 TBD/TODO；各 Step 含具体代码/命令。

**类型一致性：** `computeQuests(input): QuestState` 签名在 Task 1 定义、Task 2 消费一致；`Quest`/`QuestState`/`QuestInput` 类型贯穿一致。
