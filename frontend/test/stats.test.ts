import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/stats.js';
import type { BattleReport, Resources, General, Soldier } from '@mygame/shared';
import type { Siege, Challenge } from '../src/data.js';

test('computeStats 从战报/攻城/挑战/资源/养成派生', () => {
  const s = computeStats({
    userId: 'me',
    reports: [{ victory: true } as BattleReport, { victory: false } as BattleReport],
    sieges: [{ result: 'attacker_win' } as Siege],
    challenges: [{ challengerUserId: 'me', result: 'challenger_win' } as Challenge],
    resources: { rare: 25 } as Resources,
    general: { level: 3 } as General,
    troops: [{ count: 120 }, { count: 60 }] as Soldier[],
  });
  assert.equal(s.banditBattles, 2);
  assert.equal(s.banditWins, 1);
  assert.equal(s.banditWinRate, 0.5);
  assert.equal(s.challenges, 1);
  assert.equal(s.challengeWins, 1);
  assert.equal(s.sieges, 1);
  assert.equal(s.siegeWins, 1);
  assert.equal(s.currentRare, 25);
  assert.equal(s.troopCount, 180);
  assert.equal(s.generalLevel, 3);
});

test('computeStats 挑战胜场按玩家视角：我是挑战者直读，我是被挑战者取反', () => {
  // 我发起的挑战，胜利（challenger_win）计入胜场
  const s1 = computeStats({
    userId: 'me',
    reports: [],
    sieges: [],
    challenges: [
      { challengerUserId: 'me', targetUserId: 'them', result: 'challenger_win' } as Challenge,
    ],
    resources: null,
    general: null,
    troops: [],
  });
  assert.equal(s1.challengeWins, 1);

  // 我发起的挑战，失败（challenger_lose）不计入胜场
  const s2 = computeStats({
    userId: 'me',
    reports: [],
    sieges: [],
    challenges: [
      { challengerUserId: 'me', targetUserId: 'them', result: 'challenger_lose' } as Challenge,
    ],
    resources: null,
    general: null,
    troops: [],
  });
  assert.equal(s2.challengeWins, 0);

  // 我被挑战，对手（挑战者）失败即我获胜：challenger_lose 计入胜场
  const s3 = computeStats({
    userId: 'me',
    reports: [],
    sieges: [],
    challenges: [
      { challengerUserId: 'them', targetUserId: 'me', result: 'challenger_lose' } as Challenge,
    ],
    resources: null,
    general: null,
    troops: [],
  });
  assert.equal(s3.challengeWins, 1);

  // 我被挑战，对手（挑战者）获胜即我失败：challenger_win 不计入胜场
  const s4 = computeStats({
    userId: 'me',
    reports: [],
    sieges: [],
    challenges: [
      { challengerUserId: 'them', targetUserId: 'me', result: 'challenger_win' } as Challenge,
    ],
    resources: null,
    general: null,
    troops: [],
  });
  assert.equal(s4.challengeWins, 0);
});

test('computeStats 空数据兜底', () => {
  const s = computeStats({
    userId: 'me',
    reports: [],
    sieges: [],
    challenges: [],
    resources: null,
    general: null,
    troops: [],
  });
  assert.equal(s.banditBattles, 0);
  assert.equal(s.banditWinRate, 0);
  assert.equal(s.currentRare, 0);
  assert.equal(s.troopCount, 0);
  assert.equal(s.generalLevel, 0);
});
