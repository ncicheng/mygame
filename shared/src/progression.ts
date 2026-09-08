import { WEAPON_TIER_MAX } from './weapons.js';
import { TROOP_CATALOG } from './troops.js';

/** 三级养成数值与成长线（纯函数，前后端共用）。
 * 稀有材料为养成货币：武器升阶、武将升级/升星、兵种解锁均消耗稀有材料，
 * 消耗随当前等级/阶/星级递增，驱动打野产出与后续对战。
 */

/** 武将等级上限 */
export const GENERAL_LEVEL_MAX = 50;

/** 武将星级上限 */
export const GENERAL_STAR_MAX = 5;

/** 兵种等级上限（1-15 级） */
export const TROOP_LEVEL_MAX = TROOP_CATALOG.length;

/** 初始已解锁的兵种最高等级（低阶兵种初始可用，更高阶需解锁） */
export const INITIAL_TROOP_UNLOCK = 3;

/** 武将升级消耗稀有材料：随当前等级递增（每级 +5） */
export function generalLevelUpCost(currentLevel: number): number {
  return currentLevel * 5;
}

/** 武将升星消耗稀有材料：随当前星级递增（每星 +40） */
export function generalStarUpCost(currentStars: number): number {
  return currentStars * 40;
}

/** 武器升阶消耗稀有材料：随当前阶递增（每阶 +20） */
export function weaponUpgradeCost(currentTier: number): number {
  return currentTier * 20;
}

/** 兵种解锁消耗稀有材料：随目标等级递增（每级 +30） */
export function troopUnlockCost(targetLevel: number): number {
  return targetLevel * 30;
}

/** 武器阶数上限（复用武器表） */
export { WEAPON_TIER_MAX };
