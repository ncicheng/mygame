import type { BattleReport, Resources, General, Soldier } from '@mygame/shared';
import type { Siege, Challenge } from './data';

/** 玩家全局统计：由战报/攻城/挑战/资源/养成纯函数派生，无副作用。 */
export interface GameStats {
  banditBattles: number;
  banditWins: number;
  banditWinRate: number;
  challenges: number;
  challengeWins: number;
  sieges: number;
  siegeWins: number;
  currentRare: number;
  troopCount: number;
  generalLevel: number;
}

/** computeStats 输入：各项原始数据，资源/武将允许为 null。 */
export interface ComputeStatsInput {
  /** 当前玩家 id：挑战胜场需从玩家视角判定（挑战者或被挑战者）。 */
  userId: string;
  reports: BattleReport[];
  sieges: Siege[];
  challenges: Challenge[];
  resources: Resources | null;
  general: General | null;
  troops: Soldier[];
}

/** 派生游戏统计。 */
export function computeStats(input: ComputeStatsInput): GameStats {
  const banditBattles = input.reports.length;
  const banditWins = input.reports.filter((r) => r.victory).length;
  const challenges = input.challenges.length;
  // 挑战胜场从玩家视角判定：我是挑战者时，胜利即 challenger_win；
  // 我是被挑战者时，对手（挑战者）失败即我方胜利（challenger_lose）。
  const challengeWins = input.challenges.filter((c) =>
    c.challengerUserId === input.userId
      ? c.result === 'challenger_win'
      : c.result === 'challenger_lose',
  ).length;
  const sieges = input.sieges.length;
  const siegeWins = input.sieges.filter((s) => s.result === 'attacker_win').length;
  return {
    banditBattles,
    banditWins,
    banditWinRate: banditBattles > 0 ? banditWins / banditBattles : 0,
    challenges,
    challengeWins,
    sieges,
    siegeWins,
    currentRare: input.resources?.rare ?? 0,
    troopCount: input.troops.reduce((sum, t) => sum + t.count, 0),
    generalLevel: input.general?.level ?? 0,
  };
}
