# MyGame 新手引导 + 任务目标系统设计

日期：2026-09-09
状态：accepted

## 背景

MVP 是裸垂直切片：玩家能招募/行军/打野/养成，但无方向感、无引导、无目标，玩法不明确。本设计新增**任务目标系统**与**新手引导**，并完善相关细节，让玩家明确"下一步该做什么"。

## 架构决策

- **派生式任务（不加数据库表）**：任务进度从现有游戏状态实时计算（战报、资源、养成进度），无新 schema、无 RLS、无持久化问题，天然反映真实进度。
- **首次登录引导用 localStorage 标记**（非 DB），仅一次，可跳过。

## 1. 任务目标系统

右栏"任务"卡改为**引导式目标清单**（实时勾选 + 当前目标 + 下一步提示），从以下现有数据派生：

| # | 任务 | 完成条件（数据来源） |
|---|------|--------------------|
| 1 | 招募 100 乡勇 | army_units 乡勇 count ≥ 100（fetchArmyUnits） |
| 2 | 发起一次行军 | 存在 marches 记录（fetchActiveMarch 或历史） |
| 3 | 首次攻打野地 | battle_reports 长度 ≥ 1（fetchReports） |
| 4 | 首次打野胜利 | 任一 report.victory（fetchReports） |
| 5 | 强化武器到 2 阶 | general.weapon.tier ≥ 2（fetchGeneral） |
| 6 | 解锁高级兵种 | troop_max_unlocked > 3（fetchTroopMaxUnlocked） |
| 7 | 升级武将到 2 级 | general.level ≥ 2（fetchGeneral） |

- 顶部显示**当前未完成任务**作为目标，附"下一步"操作提示（如"点击武将→点野地打野"）。
- 完成项打勾；全部完成显示"成就达成"。

## 2. 新手引导（Tutorial 覆盖层）

首次登录（localStorage 标记 `mygame_tutorial_done`，无则弹出）分步高亮并说明：

1. 认识底部操作台（出征/招募/打野/攻城）与行动点含义
2. 选中我方武将 → 点地图目标格下达行军
3. 行军到野地 → 自动打野 → 在右栏战报卡看结果
4. 用掉落的稀有材料强化武器/解锁兵种（左栏养成卡）

- 每步：高亮框（定位到目标组件）+ 说明文字 + "下一步"按钮；可"跳过引导"。
- 引导完成后写 localStorage 标记，不再弹出。

## 3. 细节完善

- 加载屏/错误屏补 `Powered By 杨子轩@五年级` 版权页脚（CopyrightFooter 复用）
- 军团卡改为明确"敬请期待（后续迭代）"，避免误导占位
- 行动点/打野入口补齐悬停说明（hint）
- 野地在地图上轻微发光，引导去打野
- 移除根 `package.json` 遗留 `concurrently` 依赖

## 数据流

全部纯前端：读 `fetchWorld`/`fetchReports`/`fetchResources`/`fetchGeneral`/`fetchTroopMaxUnlocked`/`fetchArmyUnits` 已有数据计算任务进度与引导定位，无后端/schema 改动。复用现有前端测试基建。

## 相关决策

- 保持无服务器架构（客户端计算 + Supabase 存储），本设计不引入新后端依赖
