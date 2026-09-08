/** 武器：按 1-20 阶分档的可装备物品（武将可装备任意阶；兵只能装备对应阶） */
export interface WeaponType {
  tier: number;
  name: string;
}

/** 武器阶数上限 */
export const WEAPON_TIER_MAX = 20;

/** 武器表：1-20 阶全部武器，升阶/装备/战力共用同一份定义 */
export const WEAPON_CATALOG: readonly WeaponType[] = [
  { tier: 1, name: '木矛' },
  { tier: 2, name: '青铜剑' },
  { tier: 3, name: '环手刀' },
  { tier: 4, name: '横刀' },
  { tier: 5, name: '长枪' },
  { tier: 6, name: '弯刀' },
  { tier: 7, name: '偃月刀' },
  { tier: 8, name: '方天画戟' },
  { tier: 9, name: '金刚剑' },
  { tier: 10, name: '屠龙刀' },
  { tier: 11, name: '倚天剑' },
  { tier: 12, name: '轩辕剑' },
  { tier: 13, name: '干将莫邪' },
  { tier: 14, name: '太阿剑' },
  { tier: 15, name: '混沌剑' },
  { tier: 16, name: '诛仙剑' },
  { tier: 17, name: '昆仑镜' },
  { tier: 18, name: '盘古斧' },
  { tier: 19, name: '东皇钟' },
  { tier: 20, name: '天道权杖' },
] as const;

/** 按阶取武器名；阶不在 1-20 时返回 null */
export function getWeaponName(tier: number): string | null {
  return WEAPON_CATALOG.find((w) => w.tier === tier)?.name ?? null;
}
