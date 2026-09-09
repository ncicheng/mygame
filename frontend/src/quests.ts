import type { BattleReport, Soldier } from '@mygame/shared';

export interface Quest {
  id: string;
  title: string;
  done: boolean;
  hint: string;
}

export interface QuestState {
  quests: Quest[];
  current: Quest | null;
  allDone: boolean;
}

export interface QuestInput {
  reports: BattleReport[];
  troops: Soldier[];
  weaponTier: number;
  troopMaxUnlocked: number;
  generalLevel: number;
}

const DEFS = [
  { id: 'recruit', title: '招募 100 乡勇', hint: '底部操作台 → 招募，用粮草招募乡勇', done: (i: QuestInput) => i.troops.filter((t) => t.soldierLevel === 1).reduce((s, t) => s + t.count, 0) >= 100 },
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
