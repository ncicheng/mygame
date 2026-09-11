import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/stats.js';
import type { BattleReport, Resources, General, Soldier } from '@mygame/shared';
import type { Siege, Challenge } from '../src/data.js';

test('computeStats 从战报/攻城/挑战/资源/养成派生', () => {
  const s = computeStats({
    reports: [{ victory: true } as BattleReport, { victory: false } as BattleReport],
    sieges: [{ result: 'attacker_win' } as Siege],
    challenges: [{ result: 'challenger_win' } as Challenge],
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
  assert.equal(s.totalRare, 25);
  assert.equal(s.troopCount, 180);
  assert.equal(s.generalLevel, 3);
});

test('computeStats 空数据兜底', () => {
  const s = computeStats({
    reports: [],
    sieges: [],
    challenges: [],
    resources: null,
    general: null,
    troops: [],
  });
  assert.equal(s.banditBattles, 0);
  assert.equal(s.banditWinRate, 0);
  assert.equal(s.totalRare, 0);
  assert.equal(s.troopCount, 0);
  assert.equal(s.generalLevel, 0);
});
