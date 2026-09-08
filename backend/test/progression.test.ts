import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERAL_LEVEL_MAX,
  GENERAL_STAR_MAX,
  INITIAL_TROOP_UNLOCK,
  WEAPON_CATALOG,
  WEAPON_TIER_MAX,
  generalLevelUpCost,
  generalSidePower,
  generalStarUpCost,
  getWeaponName,
  troopUnlockCost,
  weaponUpgradeCost,
  effectiveWeaponTier,
} from '@mygame/shared';

/** 三级养成纯函数：武器表、养成数值、战力随成长提升、兵-武器等级约束 */

test('武器表：1-20 阶，名称精确对应', () => {
  assert.equal(WEAPON_CATALOG.length, 20);
  const expected = [
    '木矛', '青铜剑', '环手刀', '横刀', '长枪', '弯刀', '偃月刀', '方天画戟',
    '金刚剑', '屠龙刀', '倚天剑', '轩辕剑', '干将莫邪', '太阿剑', '混沌剑',
    '诛仙剑', '昆仑镜', '盘古斧', '东皇钟', '天道权杖',
  ];
  expected.forEach((name, i) => {
    const tier = i + 1;
    assert.equal(WEAPON_CATALOG[i].tier, tier);
    assert.equal(WEAPON_CATALOG[i].name, name);
  });
});

test('getWeaponName：按阶取武器名，越界返回 null', () => {
  assert.equal(getWeaponName(1), '木矛');
  assert.equal(getWeaponName(20), '天道权杖');
  assert.equal(getWeaponName(0), null);
  assert.equal(getWeaponName(21), null);
});

test('养成上限：武将等级 / 武将星级 / 武器阶', () => {
  assert.equal(GENERAL_LEVEL_MAX, 50);
  assert.equal(GENERAL_STAR_MAX, 5);
  assert.equal(WEAPON_TIER_MAX, 20);
});

test('武将升级消耗稀有材料：随等级递增', () => {
  // 1→2 级消耗 5，5→6 级消耗 25
  assert.equal(generalLevelUpCost(1), 5);
  assert.equal(generalLevelUpCost(5), 25);
  assert.ok(generalLevelUpCost(10) > generalLevelUpCost(1), '更高等级消耗应更多');
});

test('武将升星消耗稀有材料：随星级递增', () => {
  assert.equal(generalStarUpCost(1), 40);
  assert.equal(generalStarUpCost(2), 80);
  assert.ok(generalStarUpCost(4) > generalStarUpCost(1), '更高星级消耗应更多');
});

test('武器升阶消耗稀有材料：随阶递增', () => {
  // 1→2 阶消耗 20，10→11 阶消耗 200
  assert.equal(weaponUpgradeCost(1), 20);
  assert.equal(weaponUpgradeCost(10), 200);
  assert.ok(weaponUpgradeCost(19) > weaponUpgradeCost(1), '更高阶消耗应更多');
});

test('兵种解锁：初始解锁低阶兵种，逐级解锁消耗随等级递增', () => {
  assert.equal(INITIAL_TROOP_UNLOCK, 3, '初始应解锁 1-3 级兵种');
  // 解锁 4 级消耗 120，解锁 15 级消耗 450
  assert.equal(troopUnlockCost(4), 120);
  assert.equal(troopUnlockCost(15), 450);
  assert.ok(troopUnlockCost(15) > troopUnlockCost(4), '更高等级解锁应消耗更多');
});

test('兵-武器等级约束：武器的有效加成受部队最高兵种等级封顶', () => {
  // 兵只能装备对应阶武器：部队最高只有 3 级兵时，10 阶武器只能提供 3 阶加成
  assert.equal(effectiveWeaponTier(10, 3), 3);
  assert.equal(effectiveWeaponTier(3, 3), 3, '与最高兵等级同阶时不受限');
  assert.equal(effectiveWeaponTier(1, 1), 1);
  assert.equal(effectiveWeaponTier(5, 0), 0, '无兵时武器无有效加成');
  assert.equal(effectiveWeaponTier(null, 3), 0, '无武器时有效阶为 0');
});

test('养成后战力提升：武将升级/升星提升武将加成、武器升阶提升加成', () => {
  const army = [{ soldierLevel: 1, count: 100 }];
  // 升级：1 级（×1.0）→ 3 级（×1.10），战力随之提升
  const lv1 = generalSidePower({ generalLevel: 1, weaponTier: 1, army });
  const lv3 = generalSidePower({ generalLevel: 3, weaponTier: 1, army });
  assert.ok(lv3 > lv1, '武将升级应提升战斗单位战力');
  // 武器升阶：1 阶 → 5 阶，武器加成 50→250，战力提升
  const tier1 = generalSidePower({ generalLevel: 1, generalStars: 1, weaponTier: 1, army });
  const tier5 = generalSidePower({ generalLevel: 1, generalStars: 1, weaponTier: 5, army });
  assert.equal(tier5 - tier1, (5 - 1) * 50, '每升一阶武器战力 +50');
});

test('养成后战力提升：武将升星提升武将加成、从而提升战斗单位战力', () => {
  const army = [{ soldierLevel: 1, count: 100 }];
  // 升星：同等级同武器下，1 星（无星级加成）→ 3 星（+2 星加成），战力随之提升
  const star1 = generalSidePower({ generalLevel: 1, generalStars: 1, weaponTier: 1, army });
  const star3 = generalSidePower({ generalLevel: 1, generalStars: 3, weaponTier: 1, army });
  assert.ok(star3 > star1, '升星应提升战斗单位战力');
});
