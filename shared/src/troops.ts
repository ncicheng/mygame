import type { Resources } from './index.js';

/** 兵种：按 1-15 级分档的兵的类型定义 */
export interface TroopType {
  level: number;
  name: string;
  /** 单兵战力（由兵等级决定，Task 6 战力公式使用） */
  power: number;
  /** 每名兵的基础资源成本：粮草/铁材/金币；稀有材料由打野产出、养成消耗，招募不用 */
  cost: Resources;
}

/** 兵种表：1-15 级全部兵种，招募/养成/战力共用同一份定义 */
export const TROOP_CATALOG: readonly TroopType[] = [
  { level: 1, name: '乡勇', power: 1, cost: { food: 100, iron: 0, gold: 0, rare: 0 } },
  { level: 2, name: '弓手', power: 2, cost: { food: 150, iron: 50, gold: 0, rare: 0 } },
  { level: 3, name: '刀盾手', power: 3, cost: { food: 200, iron: 100, gold: 0, rare: 0 } },
  { level: 4, name: '铁骑', power: 4, cost: { food: 300, iron: 250, gold: 0, rare: 0 } },
  { level: 5, name: '重甲步兵', power: 5, cost: { food: 400, iron: 400, gold: 0, rare: 0 } },
  { level: 6, name: '弩兵', power: 6, cost: { food: 500, iron: 350, gold: 100, rare: 0 } },
  { level: 7, name: '虎贲', power: 7, cost: { food: 700, iron: 600, gold: 150, rare: 0 } },
  { level: 8, name: '铁浮屠', power: 8, cost: { food: 1000, iron: 1000, gold: 200, rare: 0 } },
  { level: 9, name: '神机营', power: 9, cost: { food: 1400, iron: 1300, gold: 300, rare: 0 } },
  { level: 10, name: '天策上将', power: 10, cost: { food: 2000, iron: 1800, gold: 400, rare: 0 } },
  { level: 11, name: '镇国大将军', power: 11, cost: { food: 2800, iron: 2600, gold: 500, rare: 0 } },
  { level: 12, name: '九天玄女兵', power: 12, cost: { food: 4000, iron: 3800, gold: 700, rare: 0 } },
  { level: 13, name: '太古龙骑', power: 13, cost: { food: 6000, iron: 5600, gold: 900, rare: 0 } },
  { level: 14, name: '修罗战鬼', power: 14, cost: { food: 9000, iron: 8500, gold: 1200, rare: 0 } },
  { level: 15, name: '混沌主宰', power: 15, cost: { food: 14000, iron: 13000, gold: 1600, rare: 0 } },
] as const;

/** 按等级取兵种；等级不在 1-15 时返回 null */
export function getTroopType(level: number): TroopType | null {
  return TROOP_CATALOG.find((t) => t.level === level) ?? null;
}