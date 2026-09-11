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
  totalRare: number;
  troopCount: number;
  generalLevel: number;
}

/** computeStats 输入：各项原始数据，资源/武将允许为 null。 */
export interface ComputeStatsInput {
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
  const challengeWins = input.challenges.filter((c) => c.result === 'challenger_win').length;
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
    totalRare: input.resources?.rare ?? 0,
    troopCount: input.troops.reduce((sum, t) => sum + t.count, 0),
    generalLevel: input.general?.level ?? 0,
  };
}
