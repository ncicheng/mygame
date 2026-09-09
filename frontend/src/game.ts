import {
  ACTION_COSTS,
  GENERAL_LEVEL_MAX,
  GENERAL_STAR_MAX,
  LOSER_CASUALTY_RATE,
  MARCH_TILE_MS,
  TROOP_LEVEL_MAX,
  WEAPON_TIER_MAX,
  WINNER_CASUALTY_RATE,
  effectiveWeaponTier,
  generalLevelUpCost,
  generalSidePower,
  generalStarUpCost,
  getTroopType,
  resolveCombat,
  shouldReleaseSkill,
  troopUnlockCost,
  weaponUpgradeCost,
  wildlandDrop,
  type CombatResult,
  type CombatUnit,
  type CombatSideInput,
  type General,
  type WorldMarch,
} from '@mygame/shared';
import {
  addArmyUnit,
  createMarch,
  fetchActionPoints,
  fetchGeneral,
  fetchResources,
  fetchTroopMaxUnlocked,
  levelUpGeneral as persistLevelUpGeneral,
  saveBattleResult,
  spendActionPoints,
  starUpGeneral as persistStarUpGeneral,
  unlockTroop as persistUnlockTroop,
  updateResources,
  upgradeWeapon as persistUpgradeWeapon,
} from './data';

// 本地结算编排层：从组件接收输入 → 调 shared 纯函数计算 → 调 data.ts 持久化。
// 纯逻辑留在 shared/ 或本文件的纯函数，game.ts 只做"取数据 → 计算 → 写回"。

/** game.ts 依赖的 data.ts 函数集合（可注入 mock，供单测使用）。 */
export interface GameDeps {
  fetchGeneral: typeof fetchGeneral;
  fetchTroopMaxUnlocked: typeof fetchTroopMaxUnlocked;
  fetchResources: typeof fetchResources;
  fetchActionPoints: typeof fetchActionPoints;
  saveBattleResult: typeof saveBattleResult;
  updateResources: typeof updateResources;
  addArmyUnit: typeof addArmyUnit;
  spendActionPoints: typeof spendActionPoints;
  unlockTroop: typeof persistUnlockTroop;
  levelUpGeneral: typeof persistLevelUpGeneral;
  starUpGeneral: typeof persistStarUpGeneral;
  upgradeWeapon: typeof persistUpgradeWeapon;
  createMarch: typeof createMarch;
}

/** 默认依赖：直接使用真实 data.ts 实现。 */
export const defaultDeps: GameDeps = {
  fetchGeneral,
  fetchTroopMaxUnlocked,
  fetchResources,
  fetchActionPoints,
  saveBattleResult,
  updateResources,
  addArmyUnit,
  spendActionPoints,
  unlockTroop: persistUnlockTroop,
  levelUpGeneral: persistLevelUpGeneral,
  starUpGeneral: persistStarUpGeneral,
  upgradeWeapon: persistUpgradeWeapon,
  createMarch,
};

/** 一场打野战斗的战场上下文（决定写库目标与掉落归属）。 */
export interface BattleContext {
  worldId: string;
  wildlandId: string;
  wildlandName: string;
  marchId: string;
  targetX: number;
  targetY: number;
}

/** 由字符串派生确定性种子：战斗结果离线结算时稳定可复现（与旧后端一致）。 */
function seedFromString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 曼哈顿距离：行军按网格逐格推进，距离 = 横向差 + 纵向差。 */
function manhattanDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 行军某时刻的格位置：按 MARCH_TILE_MS/曼哈顿距离逐格插值，横向优先，钳制在起终之间。 */
export function computeMarchPosition(march: WorldMarch, now: number): { x: number; y: number } {
  const distance = manhattanDistance({ x: march.originX, y: march.originY }, { x: march.targetX, y: march.targetY });
  if (distance === 0) {
    return { x: march.targetX, y: march.targetY };
  }
  const departed = new Date(march.departedAt).getTime();
  const traveled = Math.max(0, Math.min(distance, Math.floor((now - departed) / MARCH_TILE_MS)));

  let x = march.originX;
  let y = march.originY;
  const dx = Math.sign(march.targetX - march.originX);
  const dy = Math.sign(march.targetY - march.originY);
  for (let step = 0; step < traveled; step++) {
    if (x !== march.targetX) {
      x += dx;
    } else {
      y += dy;
    }
  }
  return { x, y };
}

/** 按胜负套用攻击方战损率，返回战后的部队（归零档被过滤）。 */
export function applyTroopLosses(army: CombatUnit[], result: CombatResult): CombatUnit[] {
  const rate = result.attackerWon ? WINNER_CASUALTY_RATE : LOSER_CASUALTY_RATE;
  return army
    .map((u) => ({ soldierLevel: u.soldierLevel, count: u.count - Math.floor(u.count * rate) }))
    .filter((u) => u.count > 0);
}

/** 野地稀有材料掉落量：按守军强度换算（透传 shared wildlandDrop）。 */
export function grantWildlandDrop(strength: number): number {
  return wildlandDrop(strength);
}

/**
 * 结算一场打野战斗（PvE：defender 为野地守军的 CombatSideInput）。
 * 从 data.fetchGeneral 组装攻击方 → shared resolveCombat 得结果 → data.saveBattleResult 持久化。
 */
export async function settleBattle(
  userId: string,
  generalId: string,
  defender: CombatSideInput,
  ctx: BattleContext,
  deps: GameDeps = defaultDeps,
): Promise<CombatResult> {
  const general = await deps.fetchGeneral(userId);
  if (!general || general.id !== generalId) {
    throw new Error('武将不存在');
  }

  // 打野战斗扣战斗行动点（出征 1 在 issueMarch 扣，这里扣 battle 部分）
  await deps.spendActionPoints(userId, ACTION_COSTS.bandit);

  // 兵-武器等级约束：武器加成按部队最高兵种等级封顶有效阶数
  const maxSoldierLevel = general.army.reduce((max, u) => Math.max(max, u.soldierLevel), 0);
  const effectiveTier = effectiveWeaponTier(general.weapon?.tier ?? null, maxSoldierLevel);
  const attackerInput: CombatSideInput = {
    generalLevel: general.level,
    generalStars: general.stars,
    weaponTier: effectiveTier,
    army: general.army,
  };
  const attackerPower = generalSidePower(attackerInput);
  const attackerCount = general.army.reduce((sum, u) => sum + u.count, 0);
  const defenderPower = generalSidePower(defender);
  const defenderCount = defender.army.reduce((sum, u) => sum + u.count, 0);

  const result: CombatResult = resolveCombat({
    attackerPower,
    defenderPower,
    attackerCount,
    defenderCount,
    seed: seedFromString(ctx.marchId),
    skillUsed: shouldReleaseSkill(attackerPower, defenderPower),
  });

  const victory = result.attackerWon;
  const droppedRare = victory ? grantWildlandDrop(defenderPower) : 0;

  await deps.saveBattleResult(userId, generalId, result, {
    worldId: ctx.worldId,
    wildlandId: ctx.wildlandId,
    wildlandName: ctx.wildlandName,
    marchId: ctx.marchId,
    targetX: ctx.targetX,
    targetY: ctx.targetY,
    victory,
    droppedRare,
    army: general.army,
  });

  return result;
}

/** 下达行军所需的额外字段（世界/归属/起点/时间），透传给 data.createMarch。 */
export interface IssueMarchInput {
  worldId: string;
  originX: number;
  originY: number;
  departedAt: string;
  arrivesAt: string;
}

/**
 * 下达行军编排：先扣 ACTION_COSTS.march 行动点，再落库 active 行军。
 * 打野流程中本次扣的是「出征」1 点，到达后由 settleBattle 再扣「战斗」部分。
 */
export async function issueMarch(
  userId: string,
  generalId: string,
  targetX: number,
  targetY: number,
  input: IssueMarchInput,
  deps: GameDeps = defaultDeps,
): Promise<WorldMarch> {
  await deps.spendActionPoints(userId, ACTION_COSTS.march);
  return deps.createMarch(generalId, targetX, targetY, {
    worldId: input.worldId,
    userId,
    originX: input.originX,
    originY: input.originY,
    departedAt: input.departedAt,
    arrivesAt: input.arrivesAt,
  });
}

/** 校验招募入参：兵种等级 1-15、数量为正整数。 */
async function validateRecruitInput(soldierLevel: number, count: number): Promise<void> {
  if (!Number.isInteger(soldierLevel) || soldierLevel < 1 || soldierLevel > TROOP_LEVEL_MAX) {
    throw new Error('兵种等级无效');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('招募数量无效');
  }
}

/**
 * 招募：校验兵种解锁/资源/行动点 → 扣基础资源 + 加兵 + 扣行动点。
 * 消耗 ACTION_COSTS.recruit 行动点，成本按 TROOP_CATALOG 计算。
 */
export async function recruitTroop(
  userId: string,
  generalId: string,
  soldierLevel: number,
  count: number,
  deps: GameDeps = defaultDeps,
): Promise<void> {
  await validateRecruitInput(soldierLevel, count);
  const troop = getTroopType(soldierLevel);
  if (!troop) {
    throw new Error('兵种等级无效');
  }

  const maxUnlocked = await deps.fetchTroopMaxUnlocked(userId);
  if (soldierLevel > maxUnlocked) {
    throw new Error('兵种未解锁');
  }

  const general = await deps.fetchGeneral(userId);
  if (!general || general.id !== generalId) {
    throw new Error('武将不存在');
  }

  const resources = await deps.fetchResources(userId);
  const needFood = troop.cost.food * count;
  const needIron = troop.cost.iron * count;
  const needGold = troop.cost.gold * count;
  if (resources.food < needFood || resources.iron < needIron || resources.gold < needGold) {
    throw new Error('基础资源不足，无法招募');
  }

  const ap = await deps.fetchActionPoints(userId);
  if (ap.current < ACTION_COSTS.recruit) {
    throw new Error('行动点不足');
  }

  await deps.updateResources(userId, { food: -needFood, iron: -needIron, gold: -needGold });
  await deps.addArmyUnit(userId, generalId, troop.name, soldierLevel, count);
  await deps.spendActionPoints(userId, ACTION_COSTS.recruit);
}

/** 校验武将归属并返回；非本人或不存在抛中文 Error。 */
async function requireGeneral(userId: string, generalId: string, deps: GameDeps): Promise<General> {
  const general = await deps.fetchGeneral(userId);
  if (!general || general.id !== generalId) {
    throw new Error('武将不存在');
  }
  return general;
}

/** 稀有材料足额则扣除，不足抛中文 Error。 */
async function spendRare(userId: string, cost: number, deps: GameDeps, errMsg: string): Promise<void> {
  const resources = await deps.fetchResources(userId);
  if (resources.rare < cost) {
    throw new Error(errMsg);
  }
  await deps.updateResources(userId, { rare: -cost });
}

/** 兵种解锁编排：校验逐级解锁 + 扣稀有材料 → data.unlockTroop。 */
export async function unlockTroop(
  userId: string,
  troopLevel: number,
  deps: GameDeps = defaultDeps,
): Promise<void> {
  if (!Number.isInteger(troopLevel) || troopLevel < 1 || troopLevel > TROOP_LEVEL_MAX) {
    throw new Error('兵种等级无效');
  }
  const currentMax = await deps.fetchTroopMaxUnlocked(userId);
  if (troopLevel <= currentMax) {
    throw new Error('该兵种已解锁');
  }
  if (troopLevel !== currentMax + 1) {
    throw new Error('须逐级解锁更高阶兵种');
  }
  await spendRare(userId, troopUnlockCost(troopLevel), deps, '稀有材料不足，无法解锁');
  await deps.unlockTroop(userId, troopLevel);
}

/** 武将升级编排：校验满级 + 扣稀有材料 → data.levelUpGeneral。 */
export async function levelUpGeneral(
  userId: string,
  generalId: string,
  deps: GameDeps = defaultDeps,
): Promise<void> {
  const general = await requireGeneral(userId, generalId, deps);
  if (general.level >= GENERAL_LEVEL_MAX) {
    throw new Error('武将已满级');
  }
  await spendRare(userId, generalLevelUpCost(general.level), deps, '稀有材料不足，无法升级');
  await deps.levelUpGeneral(generalId);
}

/** 武将升星编排：校验满星 + 扣稀有材料 → data.starUpGeneral。 */
export async function starUpGeneral(
  userId: string,
  generalId: string,
  deps: GameDeps = defaultDeps,
): Promise<void> {
  const general = await requireGeneral(userId, generalId, deps);
  if (general.stars >= GENERAL_STAR_MAX) {
    throw new Error('武将已满星');
  }
  await spendRare(userId, generalStarUpCost(general.stars), deps, '稀有材料不足，无法升星');
  await deps.starUpGeneral(generalId);
}

/** 武器升阶编排：校验满阶/已装备 + 扣稀有材料 → data.upgradeWeapon。 */
export async function upgradeWeapon(
  userId: string,
  generalId: string,
  deps: GameDeps = defaultDeps,
): Promise<void> {
  const general = await requireGeneral(userId, generalId, deps);
  if (!general.weapon) {
    throw new Error('武将未装备武器');
  }
  if (general.weapon.tier >= WEAPON_TIER_MAX) {
    throw new Error('武器已满阶');
  }
  await spendRare(userId, weaponUpgradeCost(general.weapon.tier), deps, '稀有材料不足，无法强化');
  await deps.upgradeWeapon(generalId);
}
