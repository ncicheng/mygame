import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchWorld,
  fetchResources,
  fetchGeneral,
  fetchArmyUnits,
  createMarch,
  cancelMarch,
  finalizeMarch,
  saveBattleResult,
  unlockTroop,
  levelUpGeneral,
  starUpGeneral,
  upgradeWeapon,
  updateResources,
  addArmyUnit,
  spendActionPoints,
} from '../src/data.js';
import type { CombatResult, CombatUnit } from '@mygame/shared';

// 数据访问层 data.ts 的测试关注点：
// 1) 每个函数都用 supabase.from(正确表名) 读写，列名与 schema.sql 一致；
// 2) 读取函数把数据库行组装成 shared/ 的领域类型（WorldStateResponse/General 等）；
// 3) 复合写入（saveBattleResult）按序写 battle_instances → battle_reports →
//    战损 → 资源/野地/武将 → 行军，任一步失败抛中文 Error；
// 4) 出错时抛带中文 message 的 Error（与 auth.ts 同款模式）。
// 依赖注入：通过可选的最后一个 client 参数注入假客户端。

interface QueryCall {
  method: string;
  args: unknown[];
}

type TableResult = { data: unknown; error?: { message: string } | null } | unknown[];

/** 构造假 supabase 客户端：from(table) 返回可 await 的链式查询构建器。
 *  perTable 按表名给出 {data,error}；.single()/.maybeSingle() 会把数组解包为首个元素。
 *  返回 { client, order }：order 记录每次 await 查询的表名顺序（用于断言写入次序）。 */
function makeFakeSupabase(
  perTable: Record<string, TableResult>,
): { client: SupabaseClient; order: string[]; callsOf: (t: string) => QueryCall[] } {
  const order: string[] = [];
  const tables = new Map<string, QueryCall[]>();
  const from = (table: string) => {
    const calls: QueryCall[] = [];
    tables.set(table, calls);
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'lt',
      'gt',
      'order',
      'limit',
      'is',
      'filter',
      'single',
      'maybeSingle',
    ]) {
      q[m] = (...a: unknown[]) => {
        calls.push({ method: m, args: a });
        return q;
      };
    }
    q.insert = (...a: unknown[]) => {
      calls.push({ method: 'insert', args: a });
      return q;
    };
    q.upsert = (...a: unknown[]) => {
      calls.push({ method: 'upsert', args: a });
      return q;
    };
    q.update = (...a: unknown[]) => {
      calls.push({ method: 'update', args: a });
      return q;
    };
    q.delete = (...a: unknown[]) => {
      calls.push({ method: 'delete', args: a });
      return q;
    };
    (q as { then?: unknown }).then = (
      onF: (v: unknown) => unknown,
      onR: (e: unknown) => unknown,
    ): Promise<unknown> => {
      const raw = perTable[table];
      const resolved: { data: unknown; error?: { message: string } | null } = Array.isArray(raw)
        ? { data: raw }
        : raw && typeof raw === 'object' && 'data' in raw
          ? (raw as { data: unknown; error?: { message: string } | null })
          : { data: raw };
      let data = resolved.data;
      const usedSingle = calls.some((c) => c.method === 'single' || c.method === 'maybeSingle');
      if (usedSingle && Array.isArray(data)) {
        data = data[0];
      }
      order.push(table);
      return Promise.resolve({ data, error: resolved.error ?? null }).then(onF, onR);
    };
    return q;
  };
  return {
    client: { from } as unknown as SupabaseClient,
    order,
    callsOf: (t: string) => tables.get(t) ?? [],
  };
}

const USER = 'u1';
const GEN = 'g1';

test('fetchWorld 组装世界/地形/城池/野地/部队/行动点', async () => {
  const { client } = makeFakeSupabase({
    generals: [
      { id: GEN, user_id: USER, name: '队长', x: 2, y: 3, created_at: '2020-01-01T00:00:00Z', world_id: 'w1' },
    ],
    worlds: [{ id: 'w1', name: '世界', width: 3, height: 2, seed: 1 }],
    world_tiles: [
      { x: 0, y: 0, terrain: 'g' },
      { x: 1, y: 0, terrain: 'f' },
      { x: 2, y: 0, terrain: 'w' },
      { x: 0, y: 1, terrain: 'g' },
      { x: 1, y: 1, terrain: 'm' },
      { x: 2, y: 1, terrain: 'g' },
    ],
    cities: [
      { id: 'c1', name: '主城', x: 0, y: 0, owner_user_id: USER },
      { id: 'c2', name: '敌城', x: 2, y: 1, owner_user_id: 'enemy' },
    ],
    wildlands: [{ id: 'wl1', name: '山贼', x: 1, y: 1, strength: 100 }],
    army_units: [{ count: 120 }],
    marches: [
      {
        id: 'm1',
        general_id: GEN,
        origin_x: 2,
        origin_y: 3,
        target_x: 1,
        target_y: 1,
        departed_at: '2020-01-01T00:00:00Z',
        arrives_at: '2020-01-01T00:00:05Z',
        status: 'active',
      },
    ],
    action_points: { current: 3, max: 5, last_recovered_at: new Date().toISOString() },
  });

  const ws = await fetchWorld(USER, client);
  assert.deepEqual(ws.world, { id: 'w1', name: '世界', width: 3, height: 2 });
  assert.deepEqual(ws.tiles, ['gfw', 'gmg']);
  assert.equal(ws.cities[0].side, 'me');
  assert.equal(ws.cities[1].side, 'enemy');
  assert.equal(ws.wildlands[0].strength, 100);
  assert.equal(ws.armies[0].troopCount, 120);
  assert.equal(ws.armies[0].side, 'me');
  assert.ok(ws.armies[0].march, '行军中的部队应附带 active 行军');
  assert.equal(ws.armies[0].march!.generalId, GEN);
  assert.equal(ws.actionPoints.current, 3);
  assert.equal(ws.actionPoints.max, 5);
});

test('fetchResources 把列组装成 Resources', async () => {
  const { client } = makeFakeSupabase({
    resources: [{ food: 10, iron: 20, rare: 30, gold: 40 }],
  });
  assert.deepEqual(await fetchResources(USER, client), { food: 10, iron: 20, rare: 30, gold: 40 });
});

test('updateResources 按增量读写 resources', async () => {
  const { client, callsOf } = makeFakeSupabase({
    resources: [{ food: 100, iron: 100, rare: 10, gold: 100 }],
  });
  await updateResources(USER, { rare: 5, food: -20 }, client);
  const update = callsOf('resources').find((c) => c.method === 'update');
  assert.ok(update, '应调用 resources.update');
  assert.deepEqual((update!.args[0] as object).food, 80);
  assert.deepEqual((update!.args[0] as object).rare, 15);
});

test('fetchGeneral 组装武将及其武器与部队', async () => {
  const { client } = makeFakeSupabase({
    generals: [{ id: GEN, name: '队长', level: 3, stars: 2, weapon_id: 'w1' }],
    weapons: [{ id: 'w1', name: '木矛', tier: 1 }],
    army_units: [{ soldier_type: '乡勇', soldier_level: 1, count: 100 }],
  });
  const g = await fetchGeneral(USER, client);
  assert.equal(g!.id, GEN);
  assert.deepEqual(g!.weapon, { id: 'w1', name: '木矛', tier: 1 });
  assert.deepEqual(g!.army, [{ soldierType: '乡勇', soldierLevel: 1, count: 100 }]);
});

test('fetchArmyUnits 映射部队行', async () => {
  const { client } = makeFakeSupabase({
    army_units: [{ soldier_type: '乡勇', soldier_level: 1, count: 80 }],
  });
  assert.deepEqual(await fetchArmyUnits(GEN, client), [{ soldierType: '乡勇', soldierLevel: 1, count: 80 }]);
});

test('createMarch 写入 marches 表并返回 WorldMarch', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: GEN, user_id: USER }],
  });
  const march = await createMarch(
    GEN,
    5,
    6,
    {
      worldId: 'w1',
      userId: USER,
      originX: 1,
      originY: 2,
      departedAt: '2020-01-01T00:00:00Z',
      arrivesAt: '2020-01-01T00:00:10Z',
    },
    client,
  );
  const ins = callsOf('marches').find((c) => c.method === 'insert');
  assert.ok(ins, '应调用 marches.insert');
  const row = ins!.args[0] as Record<string, unknown>;
  assert.equal(row.world_id, 'w1');
  assert.equal(row.general_id, GEN);
  assert.equal(row.user_id, USER);
  assert.equal(row.origin_x, 1);
  assert.equal(row.target_x, 5);
  assert.equal(row.status, 'active');
  assert.equal(march.generalId, GEN);
  assert.equal(march.status, 'active');
});

test('createMarch 拒绝指挥他人武将（归属校验）', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: GEN, user_id: 'someone-else' }],
  });
  await assert.rejects(
    () =>
      createMarch(
        GEN,
        5,
        6,
        {
          worldId: 'w1',
          userId: USER,
          originX: 1,
          originY: 2,
          departedAt: '2020-01-01T00:00:00Z',
          arrivesAt: '2020-01-01T00:00:10Z',
        },
        client,
      ),
    /不能操作他人的部队/,
  );
  assert.ok(!callsOf('marches').some((c) => c.method === 'insert'), '归属不符不应写入 marches');
});

test('cancelMarch 把行军置为 cancelled', async () => {
   const { client, callsOf } = makeFakeSupabase({
     marches: [{ id: 'm1', status: 'active' }],
   });
   await cancelMarch(USER, 'm1', client);
   const upd = callsOf('marches').find((c) => c.method === 'update');
   assert.ok(upd, '应调用 marches.update');
   assert.equal((upd!.args[0] as object).status, 'cancelled');
 });

test('finalizeMarch 把武将落位到目标格并把行军置为 arrived', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: GEN, user_id: USER, x: 0, y: 0 }],
    marches: [{ id: 'm1', status: 'active' }],
  });
  await finalizeMarch(USER, GEN, 'm1', 5, 3, client);
  const genUpd = callsOf('generals').find((c) => c.method === 'update');
  assert.ok(genUpd, '应更新 generals');
  assert.deepEqual((genUpd!.args[0] as object), { x: 5, y: 3 });
  const mUpd = callsOf('marches').find((c) => c.method === 'update');
  assert.ok(mUpd, '应更新 marches');
  assert.equal((mUpd!.args[0] as object).status, 'arrived');
});

test('saveBattleResult 按序写战报并结算胜利（资源/野地/武将/行军）', async () => {
  const { client, order, callsOf } = makeFakeSupabase({
    battle_instances: { data: null, error: null },
    battle_reports: { data: null, error: null },
    army_units: { data: [], error: null },
    resources: [{ food: 100, iron: 100, rare: 10, gold: 100 }],
    wildlands: { data: [], error: null },
    generals: { data: [], error: null },
    marches: { data: [], error: null },
  });

  const army: CombatUnit[] = [{ soldierLevel: 1, count: 100 }];
  const result: CombatResult = {
    attackerWon: true,
    skillUsed: false,
    attacker: { power: 500, troopCount: 100, casualties: 15, survivors: 85 },
    defender: { power: 300, troopCount: 100, casualties: 70, survivors: 30 },
    rounds: [],
  };

  await saveBattleResult(
    USER,
    GEN,
    result,
    {
      worldId: 'w1',
      wildlandId: 'wl1',
      wildlandName: '山贼',
      marchId: 'm1',
      targetX: 1,
      targetY: 1,
      victory: true,
      droppedRare: 5,
      army,
    },
    client,
  );

  assert.ok(callsOf('battle_instances').some((c) => c.method === 'insert'), '应写 battle_instances');
  assert.ok(callsOf('battle_reports').some((c) => c.method === 'insert'), '应写 battle_reports');

  // 资源稀有材料 +5：10 → 15
  const resUpd = callsOf('resources').find((c) => c.method === 'update');
  assert.equal((resUpd!.args[0] as object).rare, 15);

  // 野地标记被攻破
  const wildUpd = callsOf('wildlands').find((c) => c.method === 'update');
  assert.ok(wildUpd, '胜利应更新 wildlands.defeated_at');

  // 行军标记到达
  const marchUpd = callsOf('marches').find((c) => c.method === 'update');
  assert.equal((marchUpd!.args[0] as object).status, 'arrived');

  // 战前 100 兵，胜方轻损 15% → 剩 85
  const armyUpd = callsOf('army_units').find((c) => c.method === 'update');
  assert.equal((armyUpd!.args[0] as object).count, 85);

  // 写入次序：battle_instances → battle_reports → … → resources → wildlands → marches
  const first = (t: string) => order.indexOf(t);
  assert.ok(first('battle_instances') < first('battle_reports'));
  assert.ok(first('battle_reports') < first('resources'));
  assert.ok(first('resources') < first('wildlands'));
  assert.ok(first('wildlands') < first('marches'));
});

test('saveBattleResult 失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    battle_instances: { data: null, error: { message: 'permission denied' } },
  });
  const result: CombatResult = {
    attackerWon: true,
    skillUsed: false,
    attacker: { power: 1, troopCount: 1, casualties: 0, survivors: 1 },
    defender: { power: 1, troopCount: 1, casualties: 1, survivors: 0 },
    rounds: [],
  };
  await assert.rejects(
    () =>
      saveBattleResult(
        USER,
        GEN,
        result,
        { worldId: 'w1', wildlandId: 'wl1', wildlandName: 'x', marchId: 'm1', targetX: 1, targetY: 1, victory: true, droppedRare: 1, army: [] },
        client,
      ),
    /保存战斗失败/,
  );
});

test('levelUpGeneral / starUpGeneral / upgradeWeapon / unlockTroop 持久化养成', async () => {
  const lvClient = makeFakeSupabase({ generals: [{ level: 3 }] });
  await levelUpGeneral(GEN, lvClient.client);
  assert.equal(lvClient.callsOf('generals').find((c) => c.method === 'update')!.args[0].level, 4);

  const stClient = makeFakeSupabase({ generals: [{ stars: 2 }] });
  await starUpGeneral(GEN, stClient.client);
  assert.equal(stClient.callsOf('generals').find((c) => c.method === 'update')!.args[0].stars, 3);

  const wepClient = makeFakeSupabase({
    generals: [{ weapon_id: 'w1' }],
    weapons: [{ id: 'w1', tier: 1 }],
  });
  await upgradeWeapon(GEN, wepClient.client);
  assert.equal(wepClient.callsOf('weapons').find((c) => c.method === 'update')!.args[0].tier, 2);

  const progClient = makeFakeSupabase({});
  await unlockTroop(USER, 4, progClient.client);
  const ups = progClient.callsOf('progression').find((c) => c.method === 'upsert');
  assert.deepEqual(ups!.args[0], { user_id: USER, troop_max_unlocked: 4 });
});

test('读取失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    resources: { data: null, error: { message: 'no rows' } },
  });
  await assert.rejects(() => fetchResources(USER, client), /读取资源失败/);
});

test('addArmyUnit 按 (general_id,soldier_level) upsert 部队行', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: GEN, user_id: USER }],
  });
  await addArmyUnit(USER, GEN, '乡勇', 1, 50, client);
  const ups = callsOf('army_units').find((c) => c.method === 'upsert');
  assert.ok(ups, '应调用 army_units.upsert');
  const row = ups!.args[0] as Record<string, unknown>;
  assert.equal(row.user_id, USER);
  assert.equal(row.general_id, GEN);
  assert.equal(row.soldier_type, '乡勇');
  assert.equal(row.soldier_level, 1);
  assert.equal(row.count, 50);
  assert.deepEqual(ups!.args[1], { onConflict: 'general_id,soldier_level' });
});

test('addArmyUnit 招募到已有兵堆时累加而非覆盖 count', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: GEN, user_id: USER }],
    army_units: [{ count: 100 }],
  });
  await addArmyUnit(USER, GEN, '乡勇', 1, 50, client);
  const ups = callsOf('army_units').find((c) => c.method === 'upsert');
  assert.ok(ups, '应调用 army_units.upsert');
  const row = ups!.args[0] as Record<string, unknown>;
  assert.equal(row.count, 150); // 已有 100 + 新增 50 = 累加
});

test('addArmyUnit 拒绝给他人武将招兵（归属校验）', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: GEN, user_id: 'someone-else' }],
  });
  await assert.rejects(() => addArmyUnit(USER, GEN, '乡勇', 1, 50, client), /不能操作他人的部队/);
  assert.ok(!callsOf('army_units').some((c) => c.method === 'upsert'), '归属不符不应 upsert');
});

test('spendActionPoints 足额则扣减，不足抛中文 Error', async () => {
  const { client, callsOf } = makeFakeSupabase({
    action_points: { current: 3, max: 5, last_recovered_at: new Date().toISOString() },
  });
  await spendActionPoints(USER, 2, client);
  const upd = callsOf('action_points').find((c) => c.method === 'update');
  assert.ok(upd, '应调用 action_points.update');
  assert.equal((upd!.args[0] as object).current, 1); // 3 - 2

  const poor = makeFakeSupabase({
    action_points: { current: 1, max: 5, last_recovered_at: new Date().toISOString() },
  });
  await assert.rejects(() => spendActionPoints(USER, 2, poor.client), /行动点不足/);
});
