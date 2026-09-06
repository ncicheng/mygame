import type { Resources, Soldier } from '@mygame/shared';

/** 初始武将：Lv.1 乡勇部队（乡勇 1 级 × 100）+ 1 阶木矛 + 初始资源 */

export const STARTER_GENERAL = {
  name: '乡勇队长',
  level: 1,
} as const;

export const STARTER_ARMY: readonly Soldier[] = [
  { soldierType: '乡勇', soldierLevel: 1, count: 100 },
];

export const STARTER_WEAPON = {
  name: '木矛',
  tier: 1,
} as const;

/** 初始资源：粮草/铁材/稀有材料/金币 */
export const STARTER_RESOURCES: Resources = {
  food: 5000,
  iron: 2000,
  rare: 20,
  gold: 100,
};