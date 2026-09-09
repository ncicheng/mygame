import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuests } from '../src/quests.js';
import type { BattleReport } from '@mygame/shared';

function q({ reports = [], troops = [], weaponTier = 1, troopMaxUnlocked = 3, generalLevel = 1 }) {
  return computeQuests({ reports, troops, weaponTier, troopMaxUnlocked, generalLevel });
}

test('空状态下全部任务未完成，current 为第一个任务', () => {
  const s = q({});
  assert.equal(s.quests.length, 7);
  assert.equal(s.current?.id, 'recruit');
  assert.equal(s.allDone, false);
});

test('招募 100 乡勇后任务 1 完成', () => {
  const s = q({ troops: [{ soldierType: '乡勇', soldierLevel: 1, count: 120 }] });
  const r = s.quests.find((x) => x.id === 'recruit')!;
  assert.equal(r.done, true);
});

test('有战报则行军/打野/胜利任务完成', () => {
  const s = q({ reports: [{ id: 'r1', victory: true } as BattleReport] });
  assert.equal(s.quests.find((x) => x.id === 'march')!.done, true);
  assert.equal(s.quests.find((x) => x.id === 'bandit')!.done, true);
  assert.equal(s.quests.find((x) => x.id === 'win')!.done, true);
});

test('武器 2 阶 / 解锁>3 / 武将2级 分别完成对应任务', () => {
  assert.equal(q({ weaponTier: 2 }).quests.find((x) => x.id === 'weapon')!.done, true);
  assert.equal(q({ troopMaxUnlocked: 4 }).quests.find((x) => x.id === 'unlock')!.done, true);
  assert.equal(q({ generalLevel: 2 }).quests.find((x) => x.id === 'level')!.done, true);
});

test('全部完成后 current 为 null、allDone 为 true', () => {
  const s = q({ reports: [{ victory: true } as BattleReport], troops: [{ soldierType: '乡勇', soldierLevel: 1, count: 100 }], weaponTier: 2, troopMaxUnlocked: 4, generalLevel: 2 });
  assert.equal(s.allDone, true);
  assert.equal(s.current, null);
});
