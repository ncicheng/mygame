import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase';
import {
  AP_MAX,
  AP_RECOVER_MS,
  INITIAL_TROOP_UNLOCK,
  LOSER_CASUALTY_RATE,
  WINNER_CASUALTY_RATE,
  getWeaponName,
  type ActionPoints,
  type BattleReport,
  type CombatResult,
  type CombatUnit,
  type General,
  type MarchStatus,
  type Resources,
  type Soldier,
  type WorldArmy,
  type WorldCity,
  type WorldMarch,
  type WorldStateResponse,
  type WorldWildland,
} from '@mygame/shared';

// 数据访问层：封装对 Supabase 各表的读写，供 game.ts 与组件调用。
// 表名/列名与 supabase/schema.sql 完全一致；RLS 是兜底，前端仍按 user_id/general_id 显式过滤。
// 前端无多行事务：复合写入按序 await，任一步失败抛中文 Error，交由上层回滚/提示。

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 读取玩家资源卡。 */
export async function fetchResources(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<Resources> {
  const { data, error } = await client
    .from('resources')
    .select('food,iron,rare,gold')
    .eq('user_id', userId)
    .single();
  if (error) throw new Error(`读取资源失败：${error.message}`);
  if (!data) throw new Error('资源数据不存在');
  return { food: data.food, iron: data.iron, rare: data.rare, gold: data.gold };
}

/** 按增量读写资源卡：delta 各字段可为正（加）或负（减）。 */
export async function updateResources(
  userId: string,
  delta: Partial<Resources>,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data, error } = await client
    .from('resources')
    .select('food,iron,rare,gold')
    .eq('user_id', userId)
    .single();
  if (error) throw new Error(`更新资源失败：${error.message}`);
  if (!data) throw new Error('资源数据不存在');
  const next = {
    food: (data.food ?? 0) + (delta.food ?? 0),
    iron: (data.iron ?? 0) + (delta.iron ?? 0),
    rare: (data.rare ?? 0) + (delta.rare ?? 0),
    gold: (data.gold ?? 0) + (delta.gold ?? 0),
  };
  const { error: upErr } = await client.from('resources').update(next).eq('user_id', userId);
  if (upErr) throw new Error(`更新资源失败：${upErr.message}`);
}

/** 读取某武将的部队（按兵等级排序）。 */
export async function fetchArmyUnits(
  generalId: string,
  client: SupabaseClient = supabase,
): Promise<Soldier[]> {
  const { data, error } = await client
    .from('army_units')
    .select('soldier_type,soldier_level,count')
    .eq('general_id', generalId)
    .order('soldier_level');
  if (error) throw new Error(`读取部队失败：${error.message}`);
  return (data ?? []).map((r) => ({
    soldierType: r.soldier_type,
    soldierLevel: r.soldier_level,
    count: r.count,
  }));
}

/** 读取玩家的主武将（首个），含其武器与部队；无武将返回 null。 */
export async function fetchGeneral(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<General | null> {
  const { data: g, error } = await client
    .from('generals')
    .select('id,name,level,stars,weapon_id')
    .eq('user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`读取武将失败：${error.message}`);
  if (!g) return null;

  let weapon: General['weapon'] = null;
  if (g.weapon_id) {
    const { data: w, error: wErr } = await client
      .from('weapons')
      .select('id,name,tier')
      .eq('id', g.weapon_id)
      .maybeSingle();
    if (wErr) throw new Error(`读取武器失败：${wErr.message}`);
    if (w) weapon = { id: w.id, name: w.name, tier: w.tier };
  }

  const army = await fetchArmyUnits(g.id, client);
  return { id: g.id, name: g.name, level: g.level, stars: g.stars ?? 1, weapon, army };
}

/** 读取玩家已解锁的最高兵种等级（未建档则取初始解锁值）。 */
export async function fetchTroopMaxUnlocked(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<number> {
  const { data, error } = await client
    .from('progression')
    .select('troop_max_unlocked')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取养成进度失败：${error.message}`);
  return data?.troop_max_unlocked ?? INITIAL_TROOP_UNLOCK;
}

/** 读取某武将当前进行中的行军；无则 null。 */
export async function fetchActiveMarch(
  generalId: string,
  client: SupabaseClient = supabase,
): Promise<WorldMarch | null> {
  const { data, error } = await client
    .from('marches')
    .select('id,general_id,origin_x,origin_y,target_x,target_y,departed_at,arrives_at,status')
    .eq('general_id', generalId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`读取行军失败：${error.message}`);
  return data ? toWorldMarch(data) : null;
}

/** 读取某用户最近 20 条战报（供战报卡展示）。 */
export async function fetchReports(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<BattleReport[]> {
  const { data, error } = await client
    .from('battle_reports')
    .select('id,general_id,general:generals(name),wildland_name,victory,attacker_casualties,defender_casualties,dropped_rare,log,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`读取战报失败：${error.message}`);
  return (data ?? []).map((r) => {
    const rel = r.general as { name?: string } | { name?: string }[] | null | undefined;
    const generalName = Array.isArray(rel) ? rel[0]?.name ?? '' : rel?.name ?? '';
    return {
      id: r.id,
      generalId: r.general_id,
      generalName,
      wildlandName: r.wildland_name,
      victory: r.victory,
      attackerCasualties: r.attacker_casualties,
      defenderCasualties: r.defender_casualties,
      droppedRare: r.dropped_rare,
      log: r.log,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

/** 读取并推进行动力（按恢复周期补点），返回前端展示结构。 */
export async function fetchActionPoints(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<ActionPoints> {
  const { data, error } = await client
    .from('action_points')
    .select('current,max,last_recovered_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取行动力失败：${error.message}`);
  if (!data) return { current: AP_MAX, max: AP_MAX, recoverMs: AP_RECOVER_MS, nextRecoveryAt: null };

  const last = new Date(data.last_recovered_at);
  const elapsed = Date.now() - last.getTime();
  const periods = Math.max(0, Math.floor(elapsed / AP_RECOVER_MS));
  const current = Math.min(data.max, data.current + periods);
  const newLast = periods > 0 ? new Date(last.getTime() + periods * AP_RECOVER_MS) : last;
  const nextRecoveryAt = current >= data.max ? null : new Date(newLast.getTime() + AP_RECOVER_MS).toISOString();

  if (periods > 0) {
    const { error: upErr } = await client
      .from('action_points')
      .update({ current, last_recovered_at: newLast.toISOString() })
      .eq('user_id', userId);
    if (upErr) throw new Error(`更新行动力失败：${upErr.message}`);
  }
  return { current, max: data.max, recoverMs: AP_RECOVER_MS, nextRecoveryAt };
}

/** 组装登录用户视角的世界状态。部队位置取武将落库坐标，行军插值交由 game.ts 本地计算。 */
export async function fetchWorld(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<WorldStateResponse> {
  // 玩家所在世界 = 其武将所在世界；无武将时兜底到首个世界
  const { data: gen, error: genErr } = await client
    .from('generals')
    .select('world_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (genErr) throw new Error(`读取世界失败：${genErr.message}`);
  let worldId = gen?.world_id ?? null;
  if (!worldId) {
    const { data: w, error: wErr } = await client
      .from('worlds')
      .select('id')
      .order('created_at')
      .limit(1)
      .maybeSingle();
    if (wErr) throw new Error(`读取世界失败：${wErr.message}`);
    worldId = w?.id ?? null;
  }
  if (!worldId) throw new Error('世界尚未初始化，请先初始化世界数据');

  const { data: worldRow, error: worldErr } = await client
    .from('worlds')
    .select('id,name,width,height')
    .eq('id', worldId)
    .single();
  if (worldErr) throw new Error(`读取世界失败：${worldErr.message}`);
  const width = worldRow.width;
  const height = worldRow.height;

  // 地形：按行组织为字符串数组
  const { data: tileRows, error: tileErr } = await client
    .from('world_tiles')
    .select('x,y,terrain')
    .eq('world_id', worldId)
    .order('y')
    .order('x');
  if (tileErr) throw new Error(`读取地形失败：${tileErr.message}`);
  const rowBuffer: string[] = Array(height).fill('');
  for (const t of tileRows ?? []) {
    rowBuffer[t.y] += t.terrain;
  }
  const tiles = rowBuffer.map((row) => row.padEnd(width, 'g'));

  const { data: cityRows, error: cityErr } = await client
    .from('cities')
    .select('id,name,x,y,owner_user_id')
    .eq('world_id', worldId)
    .order('created_at');
  if (cityErr) throw new Error(`读取城池失败：${cityErr.message}`);
  // 注意：RLS 的 cities_select 仅返回本人城池，故 side 恒为 'me'，'enemy' 分支不可达。
  // 这是已接受的 PvE 限制——共享世界里敌方城池当前不可见，代码保留 'enemy' 以便未来开放 PvP。
  const cities: WorldCity[] = (cityRows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    x: r.x,
    y: r.y,
    side: r.owner_user_id === userId ? 'me' : 'enemy',
  }));

  const { data: wildRows, error: wildErr } = await client
    .from('wildlands')
    .select('id,name,x,y,strength')
    .eq('world_id', worldId)
    .is('defeated_at', null)
    .order('created_at');
  if (wildErr) throw new Error(`读取野地失败：${wildErr.message}`);
  const wildlands: WorldWildland[] = (wildRows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    x: r.x,
    y: r.y,
    strength: r.strength,
  }));

  const { data: armyRows, error: armyErr } = await client
    .from('generals')
    .select('id,user_id,name,x,y,created_at')
    .eq('world_id', worldId)
    .order('created_at');
  if (armyErr) throw new Error(`读取部队失败：${armyErr.message}`);
  const armies: WorldArmy[] = [];
  for (const r of armyRows ?? []) {    const { data: unitRows, error: unitErr } = await client
      .from('army_units')
      .select('count')
      .eq('general_id', r.id);
    if (unitErr) throw new Error(`读取部队失败：${unitErr.message}`);
    const troopCount = (unitRows ?? []).reduce((sum, u) => sum + (u.count ?? 0), 0);
    const march = await fetchActiveMarch(r.id, client);
    // 同 cities：RLS 的 generals_select 仅返回本人武将，side 恒为 'me'，'enemy' 不可达。
    armies.push({
      id: r.id,
      generalName: r.name,
      x: r.x,
      y: r.y,
      side: r.user_id === userId ? 'me' : 'enemy',
      troopCount,
      march,
    });
  }

  const actionPoints = await fetchActionPoints(userId, client);
  return {
    world: { id: worldRow.id, name: worldRow.name, width, height },
    tiles,
    cities,
    wildlands,
    armies,
    actionPoints,
  };
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/** 创建行军所需的额外字段（世界/归属/起点/时间）。 */
export interface CreateMarchInput {
  worldId: string;
  userId: string;
  originX: number;
  originY: number;
  departedAt: string;
  arrivesAt: string;
}

/** 归属校验：general_id 必须属于该用户，否则抛中文 Error（防占用他人行军/挂兵）。 */
async function assertGeneralOwnership(
  generalId: string,
  userId: string,
  action: string,
  client: SupabaseClient,
): Promise<void> {
  const { data: gen, error } = await client
    .from('generals')
    .select('user_id')
    .eq('id', generalId)
    .maybeSingle();
  if (error) throw new Error(`${action}失败：${error.message}`);
  if (!gen || gen.user_id !== userId) {
    throw new Error(`${action}失败：不能操作他人的部队`);
  }
}

/** 创建一条 active 行军记录并返回领域对象。 */
export async function createMarch(
  generalId: string,
  targetX: number,
  targetY: number,
  input: CreateMarchInput,
  client: SupabaseClient = supabase,
): Promise<WorldMarch> {
  // 归属校验：只能为本人的武将发起行军，防止占用他人 active 行军槽位
  await assertGeneralOwnership(generalId, input.userId, '创建行军', client);
  const marchId = crypto.randomUUID();
  const row = {
    id: marchId,
    world_id: input.worldId,
    general_id: generalId,
    user_id: input.userId,
    origin_x: input.originX,
    origin_y: input.originY,
    target_x: targetX,
    target_y: targetY,
    departed_at: input.departedAt,
    arrives_at: input.arrivesAt,
    status: 'active',
  };
  const { error } = await client.from('marches').insert(row);
  if (error) throw new Error(`创建行军失败：${error.message}`);
  return {
    id: marchId,
    generalId,
    originX: input.originX,
    originY: input.originY,
    targetX,
    targetY,
    departedAt: input.departedAt,
    arrivesAt: input.arrivesAt,
    status: 'active',
  };
}

/** 招募加兵：按 (general_id, soldier_level) 幂等 upsert，存量行则 count 累加。 */
export async function addArmyUnit(
  userId: string,
  generalId: string,
  soldierType: string,
  soldierLevel: number,
  count: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  // 归属校验：只能给自己的武将招兵，防止把兵挂到陌生武将名下
  await assertGeneralOwnership(generalId, userId, '招募', client);
  // 先读存量 count，累加后再 upsert，避免覆盖已有兵堆
  const { data: existing, error: readErr } = await client
    .from('army_units')
    .select('count')
    .eq('general_id', generalId)
    .eq('soldier_level', soldierLevel)
    .maybeSingle();
  if (readErr) throw new Error(`招募失败：${readErr.message}`);
  const existingCount = existing?.count ?? 0;
  const { error } = await client.from('army_units').upsert(
    {
      id: crypto.randomUUID(),
      user_id: userId,
      general_id: generalId,
      soldier_type: soldierType,
      soldier_level: soldierLevel,
      count: existingCount + count,
    },
    { onConflict: 'general_id,soldier_level' },
  );
  if (error) throw new Error(`招募失败：${error.message}`);
}

/** 扣除行动点：先按恢复周期补点再校验足额，扣减后写回（不足抛中文 Error）。 */
export async function spendActionPoints(
  userId: string,
  amount: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data, error } = await client
    .from('action_points')
    .select('current,max,last_recovered_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`扣除行动力失败：${error.message}`);
  if (!data) throw new Error('行动力数据不存在');

  const last = new Date(data.last_recovered_at);
  const elapsed = Date.now() - last.getTime();
  const periods = Math.max(0, Math.floor(elapsed / AP_RECOVER_MS));
  const recovered = Math.min(data.max, data.current + periods);
  const newLast = periods > 0 ? new Date(last.getTime() + periods * AP_RECOVER_MS) : last;
  if (recovered < amount) throw new Error('行动点不足');

  const { error: upErr } = await client
    .from('action_points')
    .update({ current: recovered - amount, last_recovered_at: newLast.toISOString() })
    .eq('user_id', userId);
  if (upErr) throw new Error(`扣除行动力失败：${upErr.message}`);
}

/** 取消行军：仅取消本人、仍 active 的行军，置为 cancelled。 */
export async function cancelMarch(
  userId: string,
  marchId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data, error } = await client
    .from('marches')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', marchId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .select()
    .maybeSingle();
  if (error) throw new Error(`取消行军失败：${error.message}`);
  if (!data) throw new Error('行军不存在或已结束');
}

/**
 * 结算一次纯移动（无战斗）行军的到达：把武将落位到目标格，并把该行军置为 arrived。
 * 若只刷新而不落库，行军的 status 会一直停在 active，部分唯一索引
 * marches_general_id_active_unique 会挡住后续新行军（duplicate key）。
 */
export async function finalizeMarch(
  userId: string,
  generalId: string,
  marchId: string,
  targetX: number,
  targetY: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error: genErr } = await client
    .from('generals')
    .update({ x: targetX, y: targetY })
    .eq('id', generalId)
    .eq('user_id', userId);
  if (genErr) throw new Error(`行军到达落位失败：${genErr.message}`);
  const { error: mErr } = await client
    .from('marches')
    .update({ status: 'arrived' })
    .eq('id', marchId)
    .eq('user_id', userId)
    .eq('status', 'active');
  if (mErr) throw new Error(`行军结束失败：${mErr.message}`);
}

/** 一场打野战斗的结算入参：战场上下文 + 战前部队（用于按胜负战损落库）。 */
export interface BattleSettlement {
  worldId: string;
  wildlandId: string;
  wildlandName: string;
  marchId: string;
  targetX: number;
  targetY: number;
  victory: boolean;
  droppedRare: number;
  /** 战前部队（soldierLevel/count），data 层据此套用胜负战损率写 army_units。 */
  army: CombatUnit[];
}

/**
 * 保存一场战斗的完整结算。复合写入无事务，严格按以下次序 await，任一步失败抛中文 Error：
 *   1. battle_instances（先写：野地 RLS 攻打者 UPDATE 需凭 battle_instances 匹配本人）
 *   2. battle_reports
 *   3. army_units（战损：胜方轻损 / 败方重损）
 *   4. 胜利 → resources.rare + droppedRare、wildlands.defeated_at=now、武将落位 target；
 *      战败 → 武将回主城
 *   5. marches.status='arrived'
 */
export async function saveBattleResult(
  userId: string,
  generalId: string,
  result: CombatResult,
  report: BattleSettlement,
  client: SupabaseClient = supabase,
): Promise<void> {
  const battleInstanceId = crypto.randomUUID();
  const reportId = crypto.randomUUID();

  // 1. 战斗实例
  const bi = {
    id: battleInstanceId,
    world_id: report.worldId,
    attacker_general_id: generalId,
    attacker_user_id: userId,
    defender_wildland_id: report.wildlandId,
    attacker_power: result.attacker.power,
    defender_power: result.defender.power,
    winner: report.victory ? 'attacker' : 'defender',
    attacker_casualties: result.attacker.casualties,
    defender_casualties: result.defender.casualties,
    dropped_rare: report.droppedRare,
    skill_used: result.skillUsed,
    log: result,
  };
  let r = await client.from('battle_instances').insert(bi);
  if (r.error) throw new Error(`保存战斗失败：${r.error.message}`);

  // 2. 战斗报告
  const br = {
    id: reportId,
    user_id: userId,
    general_id: generalId,
    battle_instance_id: battleInstanceId,
    wildland_id: report.wildlandId,
    wildland_name: report.wildlandName,
    victory: report.victory,
    attacker_casualties: result.attacker.casualties,
    defender_casualties: result.defender.casualties,
    dropped_rare: report.droppedRare,
    log: result,
  };
  r = await client.from('battle_reports').insert(br);
  if (r.error) throw new Error(`保存战报失败：${r.error.message}`);

  // 3. 部队战损
  const lossRate = report.victory ? WINNER_CASUALTY_RATE : LOSER_CASUALTY_RATE;
  await applyUnitLosses(client, generalId, report.army, lossRate);

  // 4. 结算
  if (report.victory) {
    await updateResources(userId, { rare: report.droppedRare }, client);
    r = await client
      .from('wildlands')
      .update({ defeated_at: new Date().toISOString() })
      .eq('id', report.wildlandId);
    if (r.error) throw new Error(`更新野地失败：${r.error.message}`);
    r = await client
      .from('generals')
      .update({ x: report.targetX, y: report.targetY })
      .eq('id', generalId);
    if (r.error) throw new Error(`更新武将位置失败：${r.error.message}`);
  } else {
    // 战败：武将回主城（不灭、不掉级，兵战损已落库）
    const { data: city, error: cityErr } = await client
      .from('cities')
      .select('x,y')
      .eq('world_id', report.worldId)
      .eq('owner_user_id', userId)
      .order('created_at')
      .limit(1)
      .maybeSingle();
    if (cityErr) throw new Error(`读取城池失败：${cityErr.message}`);
    if (city) {
      r = await client.from('generals').update({ x: city.x, y: city.y }).eq('id', generalId);
      if (r.error) throw new Error(`更新武将位置失败：${r.error.message}`);
    }
  }

  // 5. 行军标记到达
  r = await client.from('marches').update({ status: 'arrived' }).eq('id', report.marchId);
  if (r.error) throw new Error(`更新行军失败：${r.error.message}`);
}

/** 按战损率套用一档兵的战损：归零的行删除，否则更新 count。 */
async function applyUnitLosses(
  client: SupabaseClient,
  generalId: string,
  army: CombatUnit[],
  rate: number,
): Promise<void> {
  for (const unit of army) {
    const remaining = unit.count - Math.floor(unit.count * rate);
    if (remaining <= 0) {
      const { error } = await client
        .from('army_units')
        .delete()
        .eq('general_id', generalId)
        .eq('soldier_level', unit.soldierLevel);
      if (error) throw new Error(`更新部队战损失败：${error.message}`);
    } else {
      const { error } = await client
        .from('army_units')
        .update({ count: remaining })
        .eq('general_id', generalId)
        .eq('soldier_level', unit.soldierLevel);
      if (error) throw new Error(`更新部队战损失败：${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 养成
// ---------------------------------------------------------------------------

/** 兵种解锁：upsert 玩家养成进度（幂等，存量无行也能写入）。 */
export async function unlockTroop(
  userId: string,
  level: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client
    .from('progression')
    .upsert({ user_id: userId, troop_max_unlocked: level });
  if (error) throw new Error(`兵种解锁失败：${error.message}`);
}

/** 武将升级：等级 +1（上限/扣稀有材料由 game.ts 校验编排）。 */
export async function levelUpGeneral(
  generalId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data: g, error } = await client
    .from('generals')
    .select('level')
    .eq('id', generalId)
    .maybeSingle();
  if (error) throw new Error(`武将升级失败：${error.message}`);
  const { error: upErr } = await client
    .from('generals')
    .update({ level: (g?.level ?? 0) + 1 })
    .eq('id', generalId);
  if (upErr) throw new Error(`武将升级失败：${upErr.message}`);
}

/** 武将升星：星级 +1（上限/扣稀有材料由 game.ts 校验编排）。 */
export async function starUpGeneral(
  generalId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data: g, error } = await client
    .from('generals')
    .select('stars')
    .eq('id', generalId)
    .maybeSingle();
  if (error) throw new Error(`武将升星失败：${error.message}`);
  const { error: upErr } = await client
    .from('generals')
    .update({ stars: (g?.stars ?? 1) + 1 })
    .eq('id', generalId);
  if (upErr) throw new Error(`武将升星失败：${upErr.message}`);
}

/** 武器升阶：通过武将定位武器，阶 +1 并同步名称（上限/扣稀有材料由 game.ts 编排）。 */
export async function upgradeWeapon(
  generalId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data: g, error } = await client
    .from('generals')
    .select('weapon_id')
    .eq('id', generalId)
    .maybeSingle();
  if (error) throw new Error(`升级武器失败：${error.message}`);
  if (!g?.weapon_id) throw new Error('武将未装备武器');
  const { data: w, error: wErr } = await client
    .from('weapons')
    .select('id,tier')
    .eq('id', g.weapon_id)
    .maybeSingle();
  if (wErr) throw new Error(`升级武器失败：${wErr.message}`);
  const nextTier = (w?.tier ?? 0) + 1;
  const { error: upErr } = await client
    .from('weapons')
    .update({ tier: nextTier, name: getWeaponName(nextTier) })
    .eq('id', g.weapon_id);
  if (upErr) throw new Error(`升级武器失败：${upErr.message}`);
}

// ---------------------------------------------------------------------------
// 私有辅助
// ---------------------------------------------------------------------------

/** 数据库行军行 → WorldMarch（时间序列化为 ISO 字符串）。 */
function toWorldMarch(row: Record<string, unknown>): WorldMarch {
  return {
    id: row.id as string,
    generalId: row.general_id as string,
    originX: row.origin_x as number,
    originY: row.origin_y as number,
    targetX: row.target_x as number,
    targetY: row.target_y as number,
    departedAt: new Date(row.departed_at as string).toISOString(),
    arrivesAt: new Date(row.arrives_at as string).toISOString(),
    status: row.status === 'arrived' || row.status === 'cancelled' ? (row.status as MarchStatus) : 'active',
  };
}
