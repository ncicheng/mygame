import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleBattle,
  issueMarch,
  computeMarchPosition,
  applyTroopLosses,
  grantWildlandDrop,
  recruitTroop,
  unlockTroop,
  levelUpGeneral,
  starUpGeneral,
  upgradeWeapon,
  type GameDeps,
  type BattleContext,
} from '../src/game.js';
import {
  ACTION_COSTS,
  GENERAL_LEVEL_MAX,
  GENERAL_STAR_MAX,
  WEAPON_TIER_MAX,
  TROOP_LEVEL_MAX,
  WINNER_CASUALTY_RATE,
  LOSER_CASUALTY_RATE,
  wildlandDrop,
  type CombatResult,
  type CombatUnit,
  type WorldMarch,
} from '@mygame/shared';

// 本地结算编排 game.ts 的测试关注点：
// 1) settleBattle：从 data.fetchGeneral 组装攻击方 → 调 shared resolveCombat 得结果 → data.saveBattleResult 持久化；
// 2) computeMarchPosition：按 MARCH_TILE_MS/曼哈顿距离在时间轴上插值（纯函数）；
// 3) applyTroopLosses / grantWildlandDrop：纯函数套用胜负战损率与野地掉落；
// 4) recruitTroop：校验兵种解锁/资源/行动点 → 扣资源 + 加兵 + 扣行动点；
// 5) 养成编排：校验上限/逐级/稀有材料 → 扣稀有材料 → 调 data 持久化。
// 依赖注入：通过 GameDeps 注入 mock data.ts 函数（记录调用 + 返回预制值）。

/** 记录每次调用的参数（用于断言）；返回预制 impl 结果。 */
function rec<T extends (...args: unknown[]) => unknown>(impl: T): { fn: T; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = ((...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  }) as T;
  return { fn, calls };
}

interface DepsRec {
  fetchGeneral?: ReturnType<typeof rec>;
  fetchTroopMaxUnlocked?: ReturnType<typeof rec>;
  fetchResources?: ReturnType<typeof rec>;
  fetchActionPoints?: ReturnType<typeof rec>;
  saveBattleResult?: ReturnType<typeof rec>;
  updateResources?: ReturnType<typeof rec>;
  addArmyUnit?: ReturnType<typeof rec>;
  spendActionPoints?: ReturnType<typeof rec>;
  unlockTroop?: ReturnType<typeof rec>;
  levelUpGeneral?: ReturnType<typeof rec>;
  starUpGeneral?: ReturnType<typeof rec>;
  upgradeWeapon?: ReturnType<typeof rec>;
  createMarch?: ReturnType<typeof rec>;
}

/** 构建带默认实参的 GameDeps；recorded 收集每个函数的调用记录供断言。 */
function makeDeps(
  impls: Partial<Record<keyof GameDeps, (...a: unknown[]) => unknown>> = {},
): { deps: GameDeps; rec: DepsRec } {
  const r: DepsRec = {};
  const pick = (name: keyof GameDeps) => {
    const recd = rec(impls[name] ?? (() => undefined));
    r[name as keyof DepsRec] = recd;
    return recd.fn;
  };
  return {
    deps: {
      fetchGeneral: pick('fetchGeneral'),
      fetchTroopMaxUnlocked: pick('fetchTroopMaxUnlocked'),
      fetchResources: pick('fetchResources'),
      fetchActionPoints: pick('fetchActionPoints'),
      saveBattleResult: pick('saveBattleResult'),
      updateResources: pick('updateResources'),
      addArmyUnit: pick('addArmyUnit'),
      spendActionPoints: pick('spendActionPoints'),
      unlockTroop: pick('unlockTroop'),
      levelUpGeneral: pick('levelUpGeneral'),
      starUpGeneral: pick('starUpGeneral'),
      upgradeWeapon: pick('upgradeWeapon'),
      createMarch: pick('createMarch'),
    },
    rec: r,
  };
}

const USER = 'u1';
const GEN = 'g1';

const ctx: BattleContext = {
  worldId: 'w1',
  wildlandId: 'wl1',
  wildlandName: '山贼',
  marchId: 'm1',
  targetX: 5,
  targetY: 6,
};

/** 主武将：1 级 1 星，木矛，100 名乡勇 → 战力 150 */
const general = {
  id: GEN,
  name: '队长',
  level: 1,
  stars: 1,
  weapon: { id: 'w', name: '木矛', tier: 1 },
  army: [{ soldierType: '乡勇', soldierLevel: 1, count: 100 }],
};

// ---------------------------------------------------------------------------
// settleBattle
// ---------------------------------------------------------------------------

test('settleBattle 组装攻击方并调用 resolveCombat 写库（胜利）', async () => {
  const { deps, rec } = makeDeps({ fetchGeneral: () => general });
  const defender = { generalLevel: 1, generalStars: 1, weaponTier: null, army: [{ soldierLevel: 1, count: 1 }] };

  const result = await settleBattle(USER, GEN, defender, ctx, deps);

  assert.equal(result.attackerWon, true, '强攻弱应必胜');
  assert.equal(result.attacker.power, 165); // 150 × 技能加成 1.1，四舍五入
  assert.equal(result.defender.power, 1);

  const saved = rec.saveBattleResult!.calls[0] as unknown[];
  assert.equal(saved[0], USER);
  assert.equal(saved[1], GEN);
  assert.equal((saved[3] as Record<string, unknown>).wildlandId, 'wl1');
  assert.equal((saved[3] as Record<string, unknown>).marchId, 'm1');
  assert.equal((saved[3] as Record<string, unknown>).victory, true);
  assert.equal((saved[3] as Record<string, unknown>).droppedRare, wildlandDrop(1));
  assert.deepEqual((saved[3] as Record<string, unknown>).army, general.army);
});

test('settleBattle 战败时掉落为 0 且写入战败', async () => {
  const { deps, rec } = makeDeps({ fetchGeneral: () => general });
  // 守方极强 → 攻击方必败
  const defender = { generalLevel: 50, generalStars: 5, weaponTier: null, army: [{ soldierLevel: 15, count: 10000 }] };

  const result = await settleBattle(USER, GEN, defender, ctx, deps);

  assert.equal(result.attackerWon, false, '弱攻强应必败');
  const saved = rec.saveBattleResult!.calls[0] as unknown[];
  assert.equal((saved[3] as Record<string, unknown>).victory, false);
  assert.equal((saved[3] as Record<string, unknown>).droppedRare, 0);
});

test('settleBattle 打野结算扣战斗行动点（ACTION_COSTS.bandit）', async () => {
  const { deps, rec } = makeDeps({ fetchGeneral: () => general });
  const defender = { generalLevel: 1, generalStars: 1, weaponTier: null, army: [{ soldierLevel: 1, count: 1 }] };

  await settleBattle(USER, GEN, defender, ctx, deps);

  const spent = rec.spendActionPoints!.calls[0] as unknown[];
  assert.deepEqual(spent, [USER, ACTION_COSTS.bandit]);
});

test('settleBattle 行动点不足则拒绝且不写库', async () => {
  const { deps, rec } = makeDeps({
    fetchGeneral: () => general,
    spendActionPoints: () => {
      throw new Error('行动点不足');
    },
  });
  const defender = { generalLevel: 1, generalStars: 1, weaponTier: null, army: [{ soldierLevel: 1, count: 1 }] };

  await assert.rejects(() => settleBattle(USER, GEN, defender, ctx, deps), /行动点不足/);
  assert.equal(rec.saveBattleResult!.calls.length, 0);
});

// ---------------------------------------------------------------------------
// computeMarchPosition
// ---------------------------------------------------------------------------

function makeMarch(): WorldMarch {
  return {
    id: 'm1',
    generalId: GEN,
    originX: 0,
    originY: 0,
    targetX: 2,
    targetY: 1,
    departedAt: new Date(0).toISOString(),
    arrivesAt: new Date(0 + 3 * 1500).toISOString(), // 3 格 × 1500ms
    status: 'active',
  };
}

test('computeMarchPosition 起点/中点/终点插值', () => {
  const march = makeMarch();
  assert.deepEqual(computeMarchPosition(march, 0), { x: 0, y: 0 });
  // 过半（2250ms）走过 1 格 → 横向优先到 (1,0)
  assert.deepEqual(computeMarchPosition(march, 2250), { x: 1, y: 0 });
  // 走完 3 格 → 终点
  assert.deepEqual(computeMarchPosition(march, 4500), { x: 2, y: 1 });
  assert.deepEqual(computeMarchPosition(march, 99999), { x: 2, y: 1 });
});

test('computeMarchPosition 横向走满再走纵向', () => {
  const march = makeMarch();
  // 2 格（3000ms）→ (2,0)；3 格（4500ms）→ (2,1)
  assert.deepEqual(computeMarchPosition(march, 3000), { x: 2, y: 0 });
});

// ---------------------------------------------------------------------------
// applyTroopLosses / grantWildlandDrop
// ---------------------------------------------------------------------------

test('applyTroopLosses 按胜负套用战损率', () => {
  const army: CombatUnit[] = [
    { soldierLevel: 1, count: 100 },
    { soldierLevel: 2, count: 10 },
  ];
  const win: CombatResult = {
    attackerWon: true,
    skillUsed: false,
    attacker: { power: 1, troopCount: 110, casualties: 0, survivors: 110 },
    defender: { power: 1, troopCount: 1, casualties: 1, survivors: 0 },
    rounds: [],
  };
  const lose: CombatResult = { ...win, attackerWon: false };

  const won = applyTroopLosses(army, win);
  assert.deepEqual(won, [
    { soldierLevel: 1, count: 100 - Math.floor(100 * WINNER_CASUALTY_RATE) },
    { soldierLevel: 2, count: 10 - Math.floor(10 * WINNER_CASUALTY_RATE) },
  ]);

  const lost = applyTroopLosses(army, lose);
  assert.deepEqual(lost, [
    { soldierLevel: 1, count: 100 - Math.floor(100 * LOSER_CASUALTY_RATE) },
    { soldierLevel: 2, count: 10 - Math.floor(10 * LOSER_CASUALTY_RATE) },
  ]);
});

test('applyTroopLosses 战损向下取整，至少保留 1 名', () => {
  const army: CombatUnit[] = [{ soldierLevel: 1, count: 10 }];
  const lose: CombatResult = {
    attackerWon: false,
    skillUsed: false,
    attacker: { power: 1, troopCount: 10, casualties: 7, survivors: 3 },
    defender: { power: 1, troopCount: 1, casualties: 0, survivors: 1 },
    rounds: [],
  };
  // 败方 70% 战损，floor(10*0.7)=7 阵亡 → 剩 3
  assert.deepEqual(applyTroopLosses(army, lose), [{ soldierLevel: 1, count: 3 }]);
});

test('grantWildlandDrop 透传野地掉落公式', () => {
  assert.equal(grantWildlandDrop(100), wildlandDrop(100));
  assert.equal(grantWildlandDrop(5), 1);
});

// ---------------------------------------------------------------------------
// recruitTroop
// ---------------------------------------------------------------------------

test('recruitTroop 校验通过则扣资源 + 加兵 + 扣行动点', async () => {
  const { deps, rec } = makeDeps({
    fetchTroopMaxUnlocked: () => 3,
    fetchGeneral: () => general,
    fetchResources: () => ({ food: 1000, iron: 500, gold: 100, rare: 0 }),
    fetchActionPoints: () => ({ current: 3, max: 5, recoverMs: 600000, nextRecoveryAt: null }),
  });

  await recruitTroop(USER, GEN, 1, 2, deps);

  const resUpd = rec.updateResources!.calls[0] as unknown[];
  assert.deepEqual(resUpd[1], { food: -200, iron: -0, gold: -0 });

  const add = rec.addArmyUnit!.calls[0] as unknown[];
  assert.equal(add[0], USER);
  assert.equal(add[1], GEN);
  assert.equal(add[2], '乡勇');
  assert.equal(add[3], 1);
  assert.equal(add[4], 2);

  const spent = rec.spendActionPoints!.calls[0] as unknown[];
  assert.equal(spent[0], USER);
  assert.equal(spent[1], ACTION_COSTS.recruit);
});

test('recruitTroop 兵种未解锁则拒绝', async () => {
  const { deps } = makeDeps({ fetchTroopMaxUnlocked: () => 3, fetchGeneral: () => general });
  await assert.rejects(() => recruitTroop(USER, GEN, 4, 1, deps), /兵种未解锁/);
});

test('recruitTroop 基础资源不足则拒绝', async () => {
  const { deps } = makeDeps({
    fetchTroopMaxUnlocked: () => 3,
    fetchGeneral: () => general,
    fetchResources: () => ({ food: 50, iron: 0, gold: 0, rare: 0 }),
    fetchActionPoints: () => ({ current: 3, max: 5, recoverMs: 600000, nextRecoveryAt: null }),
  });
  await assert.rejects(() => recruitTroop(USER, GEN, 1, 2, deps), /基础资源不足/);
});

test('recruitTroop 行动点不足则拒绝', async () => {
  const { deps } = makeDeps({
    fetchTroopMaxUnlocked: () => 3,
    fetchGeneral: () => general,
    fetchResources: () => ({ food: 1000, iron: 500, gold: 100, rare: 0 }),
    fetchActionPoints: () => ({ current: 0, max: 5, recoverMs: 600000, nextRecoveryAt: null }),
  });
  await assert.rejects(() => recruitTroop(USER, GEN, 1, 1, deps), /行动点不足/);
});

// ---------------------------------------------------------------------------
// issueMarch
// ---------------------------------------------------------------------------

test('issueMarch 先扣出行军行动点再创建行军', async () => {
  const { deps, rec } = makeDeps({
    fetchActionPoints: () => ({ current: 3, max: 5, recoverMs: 600000, nextRecoveryAt: null }),
    createMarch: () => ({
      id: 'm1',
      generalId: GEN,
      originX: 0,
      originY: 0,
      targetX: 5,
      targetY: 6,
      departedAt: 'd',
      arrivesAt: 'a',
      status: 'active' as const,
    }),
  });

  const march = await issueMarch(
    USER,
    GEN,
    5,
    6,
    { worldId: 'w1', originX: 0, originY: 0, departedAt: 'd', arrivesAt: 'a' },
    deps,
  );

  assert.deepEqual(rec.spendActionPoints!.calls[0], [USER, ACTION_COSTS.march]);
  assert.equal(rec.createMarch!.calls.length, 1);
  const created = rec.createMarch!.calls[0] as unknown[];
  assert.equal(created[0], GEN);
  assert.equal(created[1], 5);
  assert.equal(created[2], 6);
  assert.equal((created[3] as Record<string, unknown>).worldId, 'w1');
  assert.equal((created[3] as Record<string, unknown>).userId, USER);
  assert.equal(march.targetX, 5);
});

test('issueMarch 行动点不足则拒绝且不创建行军', async () => {
  const { deps, rec } = makeDeps({
    fetchActionPoints: () => ({ current: 3, max: 5, recoverMs: 600000, nextRecoveryAt: null }),
    spendActionPoints: () => {
      throw new Error('行动点不足');
    },
    createMarch: () => ({
      id: 'm1',
      generalId: GEN,
      originX: 0,
      originY: 0,
      targetX: 5,
      targetY: 6,
      departedAt: 'd',
      arrivesAt: 'a',
      status: 'active' as const,
    }),
  });

  await assert.rejects(
    () => issueMarch(USER, GEN, 5, 6, { worldId: 'w1', originX: 0, originY: 0, departedAt: 'd', arrivesAt: 'a' }, deps),
    /行动点不足/,
  );
  assert.equal(rec.createMarch!.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 养成编排：unlockTroop / levelUp / starUp / upgradeWeapon
// ---------------------------------------------------------------------------

test('unlockTroop 校验逐级解锁并扣稀有材料', async () => {
  const { deps, rec } = makeDeps({
    fetchTroopMaxUnlocked: () => 3,
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 200 }),
  });
  await unlockTroop(USER, 4, deps);
  assert.deepEqual(rec.updateResources!.calls[0][1], { rare: -120 }); // 4*30
  assert.deepEqual(rec.unlockTroop!.calls[0], [USER, 4]);
});

test('unlockTroop 已解锁/非逐级/稀有不足均拒绝', async () => {
  const { deps } = makeDeps({ fetchTroopMaxUnlocked: () => 3, fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 500 }) });
  await assert.rejects(() => unlockTroop(USER, 3, deps), /已解锁/);
  await assert.rejects(() => unlockTroop(USER, 5, deps), /逐级/);

  const poor = makeDeps({ fetchTroopMaxUnlocked: () => 3, fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 10 }) });
  await assert.rejects(() => unlockTroop(USER, 4, poor.deps), /稀有材料不足/);
});

test('levelUpGeneral 扣稀有材料并升级，满级拒绝', async () => {
  const { deps, rec } = makeDeps({
    fetchGeneral: () => ({ ...general, level: 3 }),
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 100 }),
  });
  await levelUpGeneral(USER, GEN, deps);
  assert.deepEqual(rec.updateResources!.calls[0][1], { rare: -15 }); // 3*5
  assert.deepEqual(rec.levelUpGeneral!.calls[0], [GEN]);

  const max = makeDeps({
    fetchGeneral: () => ({ ...general, level: GENERAL_LEVEL_MAX }),
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 100 }),
  });
  await assert.rejects(() => levelUpGeneral(USER, GEN, max.deps), /已满级/);
});

test('starUpGeneral 扣稀有材料并升星，满星拒绝', async () => {
  const { deps, rec } = makeDeps({
    fetchGeneral: () => ({ ...general, stars: 2 }),
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 100 }),
  });
  await starUpGeneral(USER, GEN, deps);
  assert.deepEqual(rec.updateResources!.calls[0][1], { rare: -80 }); // 2*40
  assert.deepEqual(rec.starUpGeneral!.calls[0], [GEN]);

  const max = makeDeps({
    fetchGeneral: () => ({ ...general, stars: GENERAL_STAR_MAX }),
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 100 }),
  });
  await assert.rejects(() => starUpGeneral(USER, GEN, max.deps), /已满星/);
});

test('upgradeWeapon 扣稀有材料并升阶，满阶/无武器拒绝', async () => {
  const { deps, rec } = makeDeps({
    fetchGeneral: () => general,
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 100 }),
  });
  await upgradeWeapon(USER, GEN, deps);
  assert.deepEqual(rec.updateResources!.calls[0][1], { rare: -20 }); // 1*20
  assert.deepEqual(rec.upgradeWeapon!.calls[0], [GEN]);

  const noWeapon = makeDeps({ fetchGeneral: () => ({ ...general, weapon: null }) });
  await assert.rejects(() => upgradeWeapon(USER, GEN, noWeapon.deps), /未装备武器/);

  const max = makeDeps({
    fetchGeneral: () => ({ ...general, weapon: { id: 'w', name: 'x', tier: WEAPON_TIER_MAX } }),
    fetchResources: () => ({ food: 0, iron: 0, gold: 0, rare: 100 }),
  });
  await assert.rejects(() => upgradeWeapon(USER, GEN, max.deps), /已满阶/);
});
