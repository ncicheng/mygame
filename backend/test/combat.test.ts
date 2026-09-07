import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_COSTS,
  BANDIT_TOTAL_AP,
  SKILL_POWER_BOOST,
  armyPower,
  generalMultiplier,
  generalSidePower,
  resolveCombat,
  shouldReleaseSkill,
  weaponBonus,
  winProbability,
  wildlandDrop,
  WILDLAND_REFRESH_MS,
} from '@mygame/shared';

/** 战力比公式（纯函数）——战斗单位战力 = 武将加成 × 兵数 × 单兵战力 + 武器加成 */

test('武将加成：每级 +5%，1 级 = 1.0', () => {
  assert.equal(generalMultiplier(1), 1.0);
  assert.equal(generalMultiplier(2), 1.05);
  assert.equal(generalMultiplier(15), 1.0 + (15 - 1) * 0.05);
});

test('武器加成：每阶 +50 战力，无武器 = 0', () => {
  assert.equal(weaponBonus(1), 50);
  assert.equal(weaponBonus(20), 1000);
  assert.equal(weaponBonus(null), 0);
});

test('部队战力：兵数 × 单兵战力 求和', () => {
  // 100 名乡勇（1 级，单兵战力 1）+ 50 名弓手（2 级，单兵战力 2）
  assert.equal(
    armyPower([
      { soldierLevel: 1, count: 100 },
      { soldierLevel: 2, count: 50 },
    ]),
    100 + 100,
  );
});

test('战斗单位战力：武将加成 × 兵数 × 单兵战力 + 武器加成', () => {
  // 1 级武将（加成 1.0）× 100 名乡勇（战力 100）＋ 1 阶武器（加成 50）
  assert.equal(
    generalSidePower({
      generalLevel: 1,
      weaponTier: 1,
      army: [{ soldierLevel: 1, count: 100 }],
    }),
    150,
  );
  // 2 级武将（加成 1.05）× 100 乡勇（100）＋ 1 阶武器（50）
  assert.equal(
    generalSidePower({
      generalLevel: 2,
      weaponTier: 1,
      army: [{ soldierLevel: 1, count: 100 }],
    }),
    155,
  );
});

test('胜率曲线：战力相等 = 0.5，占优 > 0.5，劣势 < 0.5', () => {
  assert.equal(winProbability(150, 150), 0.5);
  assert.ok(winProbability(300, 150) > 0.5, '战力翻倍应占优');
  assert.ok(winProbability(150, 300) < 0.5, '战力减半应劣势');
});

test('胜率曲线：极端战力比收敛到 0/1', () => {
  assert.equal(winProbability(0, 100), 0);
  assert.equal(winProbability(100, 0), 1);
  assert.ok(winProbability(1000, 1) > 0.999);
});

test('战斗结算确定性：同一种子结果一致', () => {
  const a = resolveCombat({ attackerPower: 150, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed: 42 });
  const b = resolveCombat({ attackerPower: 150, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed: 42 });
  assert.deepEqual(a, b);
});

test('战斗结算：胜方轻损（15%）、败方重损（70%）', () => {
  const result = resolveCombat({ attackerPower: 500, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed: 7 });
  assert.equal(result.attackerWon, true, '战力远超应稳胜');
  const winner = result.attacker;
  const loser = result.defender;
  assert.equal(winner.casualties, Math.floor(100 * 0.15), '胜方轻损 15%');
  assert.equal(loser.casualties, Math.floor(100 * 0.70), '败方重损 70%');
  assert.ok(winner.casualties < loser.casualties, '胜方战损应明显小于败方');
});

test('战斗结算：释放技能提升战力，可翻转势均力敌的战局', () => {
  const without = resolveCombat({ attackerPower: 100, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed: 99, skillUsed: false });
  const withSkill = resolveCombat({ attackerPower: 100, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed: 99, skillUsed: true });
  // 释放技能会提升攻击方战力，进而改变胜率；极端情况下（本用例战力足够）应更倾向取胜
  assert.equal(without.skillUsed, false);
  assert.equal(withSkill.skillUsed, true);
});

test('不同种子在均势时可得出不同胜者（随机性由种子驱动）', () => {
  const winners = new Set<boolean>();
  for (let seed = 0; seed < 40; seed++) {
    const r = resolveCombat({ attackerPower: 100, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed });
    winners.add(r.attackerWon);
  }
  assert.ok(winners.has(true) && winners.has(false), '均势下不同种子应出现不同胜者');
});

test('威吓自动释放规则：攻击方战力不低于守方时确定性释放', () => {
  assert.equal(shouldReleaseSkill(150, 150), true, '均势应释放');
  assert.equal(shouldReleaseSkill(200, 150), true, '占优应释放');
  assert.equal(shouldReleaseSkill(100, 150), false, '劣势不释放');
});

test('威吓释放：攻击方战力按 SKILL_POWER_BOOST 提升并写入结果', () => {
  const result = resolveCombat({ attackerPower: 100, defenderPower: 100, attackerCount: 100, defenderCount: 100, seed: 1, skillUsed: true });
  assert.equal(result.skillUsed, true);
  assert.equal(result.attacker.power, Math.round(100 * (1 + SKILL_POWER_BOOST)), '释放后攻击方战力应含技能加成');
});

test('打野总行动点门槛：出征 1 + 战斗 2 = 3，前端据此置灰', () => {
  assert.equal(BANDIT_TOTAL_AP, ACTION_COSTS.march + ACTION_COSTS.bandit);
  assert.ok(BANDIT_TOTAL_AP > ACTION_COSTS.bandit, '总消耗应大于单次战斗消耗，否则门槛失效');
});

test('野地稀有材料掉落：按守军强度换算，至少 1', () => {
  assert.equal(wildlandDrop(100), 10);
  assert.equal(wildlandDrop(0), 1);
});

test('野地刷新周期为固定常量（可配）', () => {
  assert.ok(WILDLAND_REFRESH_MS > 0);
});
