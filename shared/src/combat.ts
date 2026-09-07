import { getTroopType } from './troops.js';

/**
 * 战力比公式与战斗结算（纯函数，前后端共用）。
 * 战斗单位战力 = 武将加成 × 兵数 × 单兵战力（兵等级决定）＋ 武器加成（阶决定）。
 * 双方战力比 → 胜率曲线 + 随机（种子驱动）；胜方轻损、败方重损。
 */

/** 武将加成：每级 +5%（1 级 = 1.0） */
export const GENERAL_BONUS_PER_LEVEL = 0.05;

/** 武器加成：每阶 +50 战力（无武器 = 0） */
export const WEAPON_BONUS_PER_TIER = 50;

/** 胜率曲线陡峭度：对战力比取对数后经 logistic 归一 */
export const WIN_PROB_SLOPE = 2.0;

/** 胜方轻损率：战后仅损失 15% */
export const WINNER_CASUALTY_RATE = 0.15;

/** 败方重损率：战后损失 70% */
export const LOSER_CASUALTY_RATE = 0.7;

/** 战斗播放的回合数（战斗过程展示用） */
export const BATTLE_ROUNDS = 5;

/** 释放武将技能：攻击方战力 +10% */
export const SKILL_POWER_BOOST = 0.1;

/** 野地刷新周期：被攻破后经过该时长重新刷新 */
export const WILDLAND_REFRESH_MS = 5 * 60 * 1000;

/** 部队中的一档兵（用于战力计算） */
export interface CombatUnit {
  soldierLevel: number;
  count: number;
}

/** 计算一侧（武将 + 部队）的输入 */
export interface CombatSideInput {
  generalLevel: number;
  weaponTier: number | null;
  army: CombatUnit[];
}

/** 一方在战斗中的统计 */
export interface CombatantStats {
  power: number;
  troopCount: number;
  casualties: number;
  survivors: number;
}

/** 战斗播放中的一回合：双方剩余兵力 */
export interface CombatRound {
  round: number;
  attackerSurvivors: number;
  defenderSurvivors: number;
}

/** 一场战斗的完整结算结果（可写入战报并用于前端播放） */
export interface CombatResult {
  attackerWon: boolean;
  skillUsed: boolean;
  attacker: CombatantStats;
  defender: CombatantStats;
  rounds: CombatRound[];
}

/** 可复现的伪随机数发生器（种子决定结果，便于测试） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 武将加成系数：1 + (等级-1) × 每级加成 */
export function generalMultiplier(level: number): number {
  return 1 + (level - 1) * GENERAL_BONUS_PER_LEVEL;
}

/** 武器加成（阶决定）：无武器返回 0 */
export function weaponBonus(tier: number | null): number {
  return tier ? tier * WEAPON_BONUS_PER_TIER : 0;
}

/** 部队战力：兵数 × 单兵战力 求和（未知等级兵种按 0 计） */
export function armyPower(army: CombatUnit[]): number {
  return army.reduce((sum, unit) => {
    const troop = getTroopType(unit.soldierLevel);
    return sum + unit.count * (troop?.power ?? 0);
  }, 0);
}

/** 战斗单位战力：武将加成 × 兵数 × 单兵战力 + 武器加成 */
export function generalSidePower(input: CombatSideInput): number {
  return generalMultiplier(input.generalLevel) * armyPower(input.army) + weaponBonus(input.weaponTier);
}

/** 胜率曲线：把双方战力比映射到 [0,1]（=0.5 时均势） */
export function winProbability(attackerPower: number, defenderPower: number): number {
  if (defenderPower <= 0) {
    return attackerPower <= 0 ? 0.5 : 1;
  }
  if (attackerPower <= 0) {
    return 0;
  }
  const ratio = attackerPower / defenderPower;
  return 1 / (1 + Math.exp(-WIN_PROB_SLOPE * Math.log(ratio)));
}

/** 战损：胜方轻损、败方重损，向下取整；至少有 0 名存活 */
function casualties(count: number, rate: number): number {
  return Math.floor(count * rate);
}

/**
 * 威吓自动释放规则（确定性）：攻击方战力不低于守方时释放。
 * 占优/均势时震慑敌军，为攻击方战力提供 SKILL_POWER_BOOST 加成。
 * 服务器据此在结算时确定性决定技能是否生效，前后端可一致复现；
 * 手动释放时机留给养成任务，当前为自动释放的服务器权威效果。
 */
export function shouldReleaseSkill(attackerPower: number, defenderPower: number): boolean {
  return attackerPower >= defenderPower;
}

/** 结算一场战斗（纯函数、种子驱动）；返回完整结果与播放用回合序列 */
export function resolveCombat(opts: {
  attackerPower: number;
  defenderPower: number;
  attackerCount: number;
  defenderCount: number;
  seed: number;
  skillUsed?: boolean;
}): CombatResult {
  const skillUsed = opts.skillUsed ?? false;
  const attackerPower = skillUsed ? opts.attackerPower * (1 + SKILL_POWER_BOOST) : opts.attackerPower;

  const winProb = winProbability(attackerPower, opts.defenderPower);
  const rng = mulberry32(opts.seed);
  const attackerWon = rng() < winProb;

  const winnerCount = attackerWon ? opts.attackerCount : opts.defenderCount;
  const loserCount = attackerWon ? opts.defenderCount : opts.attackerCount;
  const winnerCasualties = casualties(winnerCount, WINNER_CASUALTY_RATE);
  const loserCasualties = casualties(loserCount, LOSER_CASUALTY_RATE);

  const attackerCasualties = attackerWon ? winnerCasualties : loserCasualties;
  const defenderCasualties = attackerWon ? loserCasualties : winnerCasualties;

  const attackerSurvivors = opts.attackerCount - attackerCasualties;
  const defenderSurvivors = opts.defenderCount - defenderCasualties;

  // 播放回合：战损按回合数线性推进，最后一回合即最终存活数
  const rounds: CombatRound[] = [];
  for (let round = 1; round <= BATTLE_ROUNDS; round++) {
    const aLost = Math.floor((attackerCasualties * round) / BATTLE_ROUNDS);
    const dLost = Math.floor((defenderCasualties * round) / BATTLE_ROUNDS);
    rounds.push({
      round,
      attackerSurvivors: opts.attackerCount - aLost,
      defenderSurvivors: opts.defenderCount - dLost,
    });
  }

  return {
    attackerWon,
    skillUsed,
    attacker: {
      power: Math.round(attackerPower),
      troopCount: opts.attackerCount,
      casualties: attackerCasualties,
      survivors: attackerSurvivors,
    },
    defender: {
      power: opts.defenderPower,
      troopCount: opts.defenderCount,
      casualties: defenderCasualties,
      survivors: defenderSurvivors,
    },
    rounds,
  };
}

/** 野地稀有材料掉落量：按守军强度换算（强度 /10，至少 1） */
export function wildlandDrop(strength: number): number {
  return Math.max(1, Math.round(strength / 10));
}
