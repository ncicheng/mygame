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
  fetchGuilds,
  fetchMyGuild,
  fetchGuildMembers,
  createGuild,
  joinGuild,
  leaveGuild,
  initiateChallenge,
  fetchChallenges,
  initiateSiege,
  fetchSieges,
  fetchProtection,
  refreshWildlands,
  fetchNickname,
  setNickname,
  fetchTerritory,
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
      'or',
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
      const resolved: { data: unknown; error?: { message: string } | null; count?: number | null } = Array.isArray(raw)
        ? { data: raw }
        : raw && typeof raw === 'object' && 'data' in raw
          ? (raw as { data: unknown; error?: { message: string } | null; count?: number | null })
          : { data: raw };
      let data = resolved.data;
      // .order() 会对行数组真正排序（按列 + ascending），否则排序分支测不出来。
      const orderCall = calls.filter((c) => c.method === 'order').at(-1);
      if (orderCall && Array.isArray(data)) {
        const [col, opts] = orderCall.args as [string, { ascending?: boolean }];
        const asc = opts?.ascending ?? true;
        data = (data as Record<string, unknown>[]).slice().sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }
      const usedSingle = calls.some((c) => c.method === 'single' || c.method === 'maybeSingle');
      if (usedSingle && Array.isArray(data)) {
        data = data[0];
      }
      order.push(table);
      return Promise.resolve({ data, count: resolved.count ?? null, error: resolved.error ?? null }).then(onF, onR);
    };
    return q;
  };
  return {
      client: {
      from,
      rpc: (...a: unknown[]) => {
        const rpcCalls = tables.get('rpc') ?? [];
        rpcCalls.push({ method: 'rpc', args: a });
        tables.set('rpc', rpcCalls);
        const raw = perTable['rpc'] as { data?: unknown; error?: { message: string } | null } | undefined;
        order.push('rpc');
        return Promise.resolve(
          raw && 'error' in raw
            ? { data: raw.data ?? {}, error: raw.error }
            : { data: {}, error: null },
        );
      },
    } as unknown as SupabaseClient,
    order,
    callsOf: (t: string) => tables.get(t) ?? [],
  };
}

const USER = 'u1';
const GEN = 'g1';

test('fetchWorld 组装世界/地形/城池/野地/部队/行动点', async () => {
  const { client, order, callsOf } = makeFakeSupabase({
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

  // 查询野地前应先刷新攻破超时的野地
  const refreshRpc = callsOf('rpc').find((c) => (c.args[0] as string) === 'refresh_wildlands');
  assert.ok(refreshRpc, 'fetchWorld 应先调用 refresh_wildlands');
  assert.deepEqual(refreshRpc!.args[1], { p_world_id: 'w1' });
  assert.ok(order.indexOf('rpc') < order.indexOf('wildlands'), 'refresh_wildlands 应先于 wildlands 查询');
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

test('createGuild 插入 guilds 并让创建者加入 guild_members', async () => {
  const { client, callsOf } = makeFakeSupabase({
    guilds: { data: null, error: null },
    guild_members: { data: null, error: null },
  });
  const g = await createGuild(USER, '铁血', client);

  const gIns = callsOf('guilds').find((c) => c.method === 'insert');
  assert.ok(gIns, '应调用 guilds.insert');
  const gRow = gIns!.args[0] as Record<string, unknown>;
  assert.equal(gRow.name, '铁血');
  assert.equal(gRow.leader_user_id, USER);
  assert.ok(gRow.created_at, '创建时应写入 created_at');

  const mIns = callsOf('guild_members').find((c) => c.method === 'insert');
  assert.ok(mIns, '应调用 guild_members.insert');
  assert.deepEqual(mIns!.args[0], { guild_id: g.id, user_id: USER });

  assert.equal(g.name, '铁血');
  assert.equal(g.leaderUserId, USER);
});

test('joinGuild 插入本人 guild_members 行', async () => {
  const { client, callsOf } = makeFakeSupabase({
    guild_members: { data: null, error: null },
  });
  await joinGuild(USER, 'g1', client);
  const ins = callsOf('guild_members').find((c) => c.method === 'insert');
  assert.ok(ins, '应调用 guild_members.insert');
  assert.deepEqual(ins!.args[0], { guild_id: 'g1', user_id: USER });
});

test('leaveGuild 删除本人 guild_members 行', async () => {
  const { client, callsOf } = makeFakeSupabase({
    guild_members: { data: null, error: null },
  });
  await leaveGuild(USER, 'g1', client);
  const del = callsOf('guild_members').find((c) => c.method === 'delete');
  assert.ok(del, '应调用 guild_members.delete');
  assert.ok(callsOf('guild_members').some((c) => c.method === 'eq' && c.args[0] === 'guild_id' && c.args[1] === 'g1'));
  assert.ok(callsOf('guild_members').some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER));
});

test('fetchMyGuild 通过 guild_members 反查 guild', async () => {
  const { client } = makeFakeSupabase({
    guild_members: [{ guild_id: 'g1' }],
    guilds: [{ id: 'g1', name: '铁血', leader_user_id: USER, created_at: '2020-01-01T00:00:00Z' }],
  });
  const g = await fetchMyGuild(USER, client);
  assert.equal(g!.id, 'g1');
  assert.equal(g!.name, '铁血');
  assert.equal(g!.leaderUserId, USER);
  assert.equal(g!.createdAt, '2020-01-01T00:00:00.000Z');
});

test('fetchMyGuild 无成员关系时返回 null', async () => {
  const { client } = makeFakeSupabase({
    guild_members: [],
  });
  assert.equal(await fetchMyGuild(USER, client), null);
});

test('fetchGuilds 列出全部军团', async () => {
  const { client } = makeFakeSupabase({
    guilds: [
      { id: 'g1', name: '铁血', leader_user_id: USER, created_at: '2020-01-01T00:00:00Z' },
      { id: 'g2', name: '兄弟会', leader_user_id: 'u2', created_at: '2020-01-02T00:00:00Z' },
    ],
  });
  const list = await fetchGuilds(client);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'g1', name: '铁血', leaderUserId: USER, createdAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(list[1].name, '兄弟会');
});

test('fetchGuildMembers 列出军团成员', async () => {
  const { client } = makeFakeSupabase({
    guild_members: [
      { guild_id: 'g1', user_id: USER, joined_at: '2020-01-01T00:00:00Z' },
      { guild_id: 'g1', user_id: 'u2', joined_at: '2020-01-02T00:00:00Z' },
    ],
  });
  const list = await fetchGuildMembers('g1', client);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { guildId: 'g1', userId: USER, joinedAt: '2020-01-01T00:00:00.000Z' });
});

test('initiateChallenge 插入 pending 挑战并调用 resolve_pvp', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: 'tgt', user_id: 'u2' }],
    challenges: { data: null, error: null },
  });
  await initiateChallenge(USER, 'chg', 'tgt', client);

  const ins = callsOf('challenges').find((c) => c.method === 'insert');
  assert.ok(ins, '应插入 challenges');
  const row = ins!.args[0] as Record<string, unknown>;
  assert.equal(row.challenger_user_id, USER);
  assert.equal(row.target_user_id, 'u2');
  assert.equal(row.challenger_general_id, 'chg');
  assert.equal(row.target_general_id, 'tgt');
  assert.equal(row.status, 'pending');

  const rpcCall = callsOf('rpc').find((c) => (c.args[0] as string) === 'resolve_pvp');
  assert.ok(rpcCall, '应调用 resolve_pvp');
  assert.deepEqual(rpcCall!.args[1], { p_challenger_general_id: 'chg', p_target_general_id: 'tgt' });
});

test('initiateChallenge resolve_pvp 失败时删除刚插入的 pending 行并抛错', async () => {
  const { client, callsOf } = makeFakeSupabase({
    generals: [{ id: 'tgt', user_id: 'u2' }],
    challenges: { data: [{ id: 'cX' }], error: null },
    rpc: { data: null, error: { message: 'boom' } },
  });

  await assert.rejects(() => initiateChallenge(USER, 'chg', 'tgt', client), /结算挑战失败/);

  const del = callsOf('challenges').find((c) => c.method === 'delete');
  assert.ok(del, 'RPC 失败后应删除插入的挑战');
  const idEq = callsOf('challenges').find((c) => c.method === 'eq' && c.args[0] === 'id');
  assert.equal(idEq?.args[1], 'cX', '应按插入的 id 删除 pending 行');
});

test('fetchChallenges 读自己相关的挑战并映射', async () => {
  const { client, callsOf } = makeFakeSupabase({
    challenges: [
      { id: 'c1', challenger_user_id: USER, target_user_id: 'u2', status: 'pending', result: null, result_summary: null, created_at: '2020-01-01T00:00:00Z' },
      { id: 'c2', challenger_user_id: 'u2', target_user_id: USER, status: 'resolved', result: 'challenger_win', result_summary: { result: 'challenger_win' }, created_at: '2020-01-02T00:00:00Z' },
    ],
  });
  const list = await fetchChallenges(USER, client);
  assert.equal(list.length, 2);
  // fetchChallenges 按 created_at 倒序，c2（2020-01-02，较新）应排在最前。
  assert.deepEqual(list[0], {
    id: 'c2',
    challengerUserId: 'u2',
    targetUserId: USER,
    status: 'resolved',
    result: 'challenger_win',
    resultSummary: { result: 'challenger_win' },
    createdAt: '2020-01-02T00:00:00.000Z',
  });
  assert.equal(list[1].result, null);
  assert.equal(list[1].resultSummary, null);
  assert.ok(callsOf('challenges').some((c) => c.method === 'or'), '应按或条件过滤双方');
});

test('fetchProtection 读取 progression 的 peace_protection_until', async () => {
  const { client, callsOf } = makeFakeSupabase({
    progression: [{ peace_protection_until: '2030-01-01T00:00:00Z' }],
  });
  const p = await fetchProtection(USER, client);
  assert.deepEqual(p, { peaceProtectionUntil: '2030-01-01T00:00:00Z' });
  const sel = callsOf('progression').find((c) => c.method === 'select');
  assert.ok(sel, '应读取 progression');
  assert.deepEqual(sel!.args[0], 'peace_protection_until');
  assert.ok(callsOf('progression').some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER));
});

test('fetchProtection 无 progression 行时返回 null', async () => {
  const { client } = makeFakeSupabase({
    progression: [],
  });
  assert.deepEqual(await fetchProtection(USER, client), { peaceProtectionUntil: null });
});

test('refreshWildlands 调 RPC refresh_wildlands 且传 p_world_id', async () => {
  const { client, callsOf } = makeFakeSupabase({});
  await refreshWildlands('w1', client);
  const rpcCall = callsOf('rpc').find((c) => (c.args[0] as string) === 'refresh_wildlands');
  assert.ok(rpcCall, '应调用 refresh_wildlands');
  assert.deepEqual(rpcCall!.args[1], { p_world_id: 'w1' });
});

test('refreshWildlands 失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    rpc: { data: null, error: { message: 'boom' } },
  });
  await assert.rejects(() => refreshWildlands('w1', client), /刷新野地失败/);
});

test('fetchNickname 读取 profiles 的 username', async () => {
  const { client, callsOf } = makeFakeSupabase({
    profiles: [{ username: '玩家123456' }],
  });
  assert.equal(await fetchNickname(USER, client), '玩家123456');
  const sel = callsOf('profiles').find((c) => c.method === 'select');
  assert.ok(sel, '应读取 profiles');
  assert.deepEqual(sel!.args[0], 'username');
  assert.ok(callsOf('profiles').some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER));
});

test('fetchNickname 无 profile 行时返回 null', async () => {
  const { client } = makeFakeSupabase({
    profiles: [],
  });
  assert.equal(await fetchNickname(USER, client), null);
});

test('fetchNickname 失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    profiles: { data: null, error: { message: 'no rows' } },
  });
  await assert.rejects(() => fetchNickname(USER, client), /读取昵称失败/);
});

test('setNickname 通过 upsert 写入 profiles', async () => {
  const { client, callsOf } = makeFakeSupabase({});
  await setNickname(USER, '新昵称', client);
  const ups = callsOf('profiles').find((c) => c.method === 'upsert');
  assert.ok(ups, '应调用 profiles.upsert');
  assert.deepEqual(ups!.args[0], { user_id: USER, username: '新昵称' });
  assert.deepEqual(ups!.args[1], { onConflict: 'user_id' });
});

test('setNickname 失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    profiles: { data: null, error: { message: 'duplicate' } },
  });
  await assert.rejects(() => setNickname(USER, '新昵称', client), /设置昵称失败/);
});

test('fetchTerritory 统计该用户拥有的城池数', async () => {
  const { client, callsOf } = makeFakeSupabase({
    cities: { data: null, count: 3, error: null },
  });
  assert.equal(await fetchTerritory(USER, 'w1', client), 3);
  assert.ok(callsOf('cities').some((c) => c.method === 'select'));
  assert.ok(callsOf('cities').some((c) => c.method === 'eq' && c.args[0] === 'owner_user_id' && c.args[1] === USER));
  assert.ok(callsOf('cities').some((c) => c.method === 'eq' && c.args[0] === 'world_id' && c.args[1] === 'w1'));
});

test('fetchTerritory 无城池时返回 0', async () => {
  const { client } = makeFakeSupabase({
    cities: { data: null, count: 0, error: null },
  });
  assert.equal(await fetchTerritory(USER, 'w1', client), 0);
});

test('fetchTerritory 失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    cities: { data: null, error: { message: 'boom' } },
  });
  await assert.rejects(() => fetchTerritory(USER, 'w1', client), /读取领地失败/);
});

test('initiateSiege 插入 pending sieges 行并调用 resolve_siege', async () => {
  const { client, callsOf } = makeFakeSupabase({
    sieges: { data: null, error: null },
  });
  await initiateSiege(USER, 'ag1', 'c1', client);

  const ins = callsOf('sieges').find((c) => c.method === 'insert');
  assert.ok(ins, '应插入 sieges');
  const row = ins!.args[0] as Record<string, unknown>;
  assert.equal(row.attacker_user_id, USER);
  assert.equal(row.target_city_id, 'c1');
  assert.equal(row.status, 'pending');

  const rpcCall = callsOf('rpc').find((c) => (c.args[0] as string) === 'resolve_siege');
  assert.ok(rpcCall, '应调用 resolve_siege');
  assert.deepEqual(rpcCall!.args[1], { p_attacker_general_id: 'ag1', p_target_city_id: 'c1' });
});

test('initiateSiege resolve_siege 失败时删除刚插入的 pending 行并抛错', async () => {
  const { client, callsOf } = makeFakeSupabase({
    sieges: { data: [{ id: 'sX' }], error: null },
    rpc: { data: null, error: { message: 'boom' } },
  });

  await assert.rejects(() => initiateSiege(USER, 'ag1', 'c1', client), /结算攻城失败/);

  const del = callsOf('sieges').find((c) => c.method === 'delete');
  assert.ok(del, 'RPC 失败后应删除插入的 sieges 行');
  const idEq = callsOf('sieges').find((c) => c.method === 'eq' && c.args[0] === 'id');
  assert.equal(idEq?.args[1], 'sX', '应按插入的 id 删除 pending 行');
});

test('fetchSieges 读取自己的攻城记录并映射', async () => {
  const { client, callsOf } = makeFakeSupabase({
    sieges: [
      { id: 's1', attacker_user_id: USER, target_city_id: 'c1', status: 'pending', result: null, created_at: '2020-01-01T00:00:00Z' },
      { id: 's2', attacker_user_id: USER, target_city_id: 'c2', status: 'resolved', result: 'attacker_win', created_at: '2020-01-02T00:00:00Z' },
    ],
  });
  const list = await fetchSieges(USER, client);
  assert.equal(list.length, 2);
  // fetchSieges 按 created_at 倒序，s2（2020-01-02，较新）应排在最前。
  assert.deepEqual(list[0], {
    id: 's2',
    attackerUserId: USER,
    targetCityId: 'c2',
    status: 'resolved',
    result: 'attacker_win',
    createdAt: '2020-01-02T00:00:00.000Z',
  });
  assert.equal(list[1].result, null);
  assert.ok(callsOf('sieges').some((c) => c.method === 'eq' && c.args[0] === 'attacker_user_id' && c.args[1] === USER), '应按 attacker_user_id 过滤');
});

test('fetchSieges 失败时抛中文 Error', async () => {
  const { client } = makeFakeSupabase({
    sieges: { data: null, error: { message: 'boom' } },
  });
  await assert.rejects(() => fetchSieges(USER, client), /读取攻城记录失败/);
});
