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

/** 读取玩家免战期截止时间；无建档或无免战期返回 null。 */
export async function fetchProtection(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<{ peaceProtectionUntil: string | null }> {
  const { data, error } = await client
    .from('progression')
    .select('peace_protection_until')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取免战期失败：${error.message}`);
  return { peaceProtectionUntil: data?.peace_protection_until ?? null };
}

/** 读取玩家昵称（profiles.username）；无建档或无昵称返回 null。 */
export async function fetchNickname(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<string | null> {
  const { data, error } = await client
    .from('profiles')
    .select('username')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取昵称失败：${error.message}`);
  return data?.username ?? null;
}

/** 统计某用户在某世界拥有的城池数（领地数）。 */
export async function fetchTerritory(
  userId: string,
  worldId: string,
  client: SupabaseClient = supabase,
): Promise<number> {
  const { count, error } = await client
    .from('cities')
    .select('id', { count: 'exact', head: true })
    .eq('owner_user_id', userId)
    .eq('world_id', worldId);
  if (error) throw new Error(`读取领地失败：${error.message}`);
  return count ?? 0;
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

  // 先刷新攻破超时（5 分钟）的野地，使其在本轮查询中重新出现
  await refreshWildlands(worldId, client);

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
    .select('id,user_id,name,level,x,y,created_at')
    .eq('world_id', worldId)
    .order('created_at');
  if (armyErr) throw new Error(`读取部队失败：${armyErr.message}`);

  // 收集需要展示昵称/等级的拥有者 id（城池拥有者 + 部队将领），批量经 RPC 获取
  const ownerIds = new Set<string>();
  for (const c of cityRows ?? []) ownerIds.add(c.owner_user_id);
  for (const r of armyRows ?? []) ownerIds.add(r.user_id);
  // 昵称/等级经 SECURITY DEFINER 函数返回，绕过 profiles 的 RLS 限制，保证地图标记可显示
  const userInfo: Record<string, { nickname: string | null; level: number | null }> = {};
  if (ownerIds.size > 0) {
    const ownerList = [...ownerIds];
    const { data, error } = await client.rpc('get_players_display', { p_ids: ownerList });
    if (error) throw new Error(`读取玩家信息失败：${error.message}`);
    if (data && typeof data === 'object') {
      for (const [uid, info] of Object.entries(data as Record<string, { nickname?: string | null; level?: number | null }>)) {
        userInfo[uid] = { nickname: info?.nickname ?? null, level: info?.level ?? null };
      }
    }
  }

  // 城池：RLS 已开放所有城池可见（cities_select auth.uid() IS NOT NULL），side 依归属区分 me/enemy。
  const cities: WorldCity[] = (cityRows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    x: r.x,
    y: r.y,
    side: r.owner_user_id === userId ? 'me' : 'enemy',
    ownerName: userInfo[r.owner_user_id]?.nickname ?? null,
    ownerLevel: userInfo[r.owner_user_id]?.level ?? null,
  }));

  const armies: WorldArmy[] = [];
  for (const r of armyRows ?? []) {
    const { data: unitRows, error: unitErr } = await client
      .from('army_units')
      .select('count')
      .eq('general_id', r.id);
    if (unitErr) throw new Error(`读取部队失败：${unitErr.message}`);
    const troopCount = (unitRows ?? []).reduce((sum, u) => sum + (u.count ?? 0), 0);
    const march = await fetchActiveMarch(r.id, client);
    // 共享世界：generals_select 对所有登录用户可见（不只本人），故 side 依归属区分 me/enemy。
    armies.push({
      id: r.id,
      generalName: r.name,
      x: r.x,
      y: r.y,
      side: r.user_id === userId ? 'me' : 'enemy',
      generalLevel: r.level,
      ownerName: userInfo[r.user_id]?.nickname ?? null,
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
// 野地刷新
// ---------------------------------------------------------------------------

/**
 * 刷新野地：调 refresh_wildlands RPC（SECURITY DEFINER）把攻破超时（5 分钟）的野地
 * defeated_at 清空，使其在 fetchWorld 的 defeated_at IS NULL 过滤中重新出现。
 * RPC 参数名与 schema.sql 定义一致为 p_world_id。
 */
export async function refreshWildlands(
  worldId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('refresh_wildlands', { p_world_id: worldId });
  if (error) throw new Error(`刷新野地失败：${error.message}`);
}

// ---------------------------------------------------------------------------
// 军团
// ---------------------------------------------------------------------------

/** 军团领域对象。leaderUserId 映射 guilds.leader_user_id。 */
export interface Guild {
  id: string;
  name: string;
  leaderUserId: string;
  createdAt: string;
  /** 军团成员数（fetchGuilds 已聚合填充） */
  memberCount?: number;
  /** 盟主昵称（fetchGuilds 已聚合填充；缺失为 null） */
  leaderName?: string | null;
}

/** 军团成员领域对象。joinedAt 映射 guild_members.joined_at。 */
export interface GuildMember {
  guildId: string;
  userId: string;
  joinedAt: string;
}

/** 列出全部军团（含成员数与盟主昵称，供排序选择）。 */
export async function fetchGuilds(
  client: SupabaseClient = supabase,
): Promise<Guild[]> {
  const { data, error } = await client
    .from('guilds')
    .select('id,name,leader_user_id,created_at')
    .order('created_at');
  if (error) throw new Error(`读取军团失败：${error.message}`);
  const guilds = (data ?? []).map((r) => toGuild(r));
  if (guilds.length === 0) return guilds;

  const leaderIds = guilds.map((g) => g.leaderUserId);

  // 成员数：按 guild_id 聚合
  const { data: memberRows, error: mErr } = await client
    .from('guild_members')
    .select('guild_id');
  if (!mErr) {
    const countMap: Record<string, number> = {};
    for (const row of memberRows ?? []) {
      const gid = row.guild_id as string;
      countMap[gid] = (countMap[gid] ?? 0) + 1;
    }
    for (const g of guilds) g.memberCount = countMap[g.id] ?? 0;
  }

  // 盟主昵称：批量拉取
  const { data: nickRows, error: nErr } = await client
    .from('profiles')
    .select('user_id,username')
    .in('user_id', leaderIds);
  if (!nErr) {
    const nickMap: Record<string, string> = {};
    for (const row of nickRows ?? []) nickMap[row.user_id as string] = row.username as string;
    for (const g of guilds) g.leaderName = nickMap[g.leaderUserId] ?? null;
  }

  return guilds;
}

/** 读取玩家所属军团：先经 guild_members 反查 guild_id，再读 guilds；无则 null。 */
export async function fetchMyGuild(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<Guild | null> {
  const { data: m, error } = await client
    .from('guild_members')
    .select('guild_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取所属军团失败：${error.message}`);
  if (!m?.guild_id) return null;

  const { data: g, error: gErr } = await client
    .from('guilds')
    .select('id,name,leader_user_id,created_at')
    .eq('id', m.guild_id)
    .maybeSingle();
  if (gErr) throw new Error(`读取军团失败：${gErr.message}`);
  return g ? toGuild(g) : null;
}

/** 列出某军团的全部成员。 */
export async function fetchGuildMembers(
  guildId: string,
  client: SupabaseClient = supabase,
): Promise<GuildMember[]> {
  const { data, error } = await client
    .from('guild_members')
    .select('guild_id,user_id,joined_at')
    .eq('guild_id', guildId);
  if (error) throw new Error(`读取军团成员失败：${error.message}`);
  return (data ?? []).map((r) => ({
    guildId: r.guild_id,
    userId: r.user_id,
    joinedAt: new Date(r.joined_at).toISOString(),
  }));
}

/** 创建军团：插入 guilds 并让创建者作为 leader 加入 guild_members。 */
export async function createGuild(
  userId: string,
  name: string,
  client: SupabaseClient = supabase,
): Promise<Guild> {
  const guildId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const { error } = await client.from('guilds').insert({
    id: guildId,
    name,
    leader_user_id: userId,
    created_at: createdAt,
  });
  if (error) throw new Error(`创建军团失败：${error.message}`);
  const { error: mErr } = await client.from('guild_members').insert({
    guild_id: guildId,
    user_id: userId,
  });
  if (mErr) throw new Error(`创建军团失败：${mErr.message}`);
  return { id: guildId, name, leaderUserId: userId, createdAt };
}

/** 加入军团：插入本人 guild_members 行。 */
export async function joinGuild(
  userId: string,
  guildId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.from('guild_members').insert({
    guild_id: guildId,
    user_id: userId,
  });
  if (error) throw new Error(`加入军团失败：${error.message}`);
}

/** 退出军团：删除本人 guild_members 行。 */
export async function leaveGuild(
  userId: string,
  guildId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client
    .from('guild_members')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);
  if (error) throw new Error(`退出军团失败：${error.message}`);
}

/** 盟主重命名军团（RLS：仅 leader 可改 guilds）。 */
export async function renameGuild(
  guildId: string,
  name: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.from('guilds').update({ name }).eq('id', guildId);
  if (error) throw new Error(`重命名军团失败：${error.message}`);
}

/** 盟主解散军团（RLS：仅 leader 可删 guilds；成员行级联删除）。 */
export async function disbandGuild(
  guildId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.from('guilds').delete().eq('id', guildId);
  if (error) throw new Error(`解散军团失败：${error.message}`);
}

/** 盟主将某成员移出军团（RLS：leader 策略允许）。 */
export async function kickGuildMember(
  guildId: string,
  userId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client
    .from('guild_members')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);
  if (error) throw new Error(`移出军团成员失败：${error.message}`);
}

// ---------------------------------------------------------------------------
// PvP 挑战
// ---------------------------------------------------------------------------

/** PvP 挑战领域对象。camelCase 字段映射 challenges 表 snake_case 列。 */
export interface Challenge {
  id: string;
  challengerUserId: string;
  targetUserId: string;
  status: string;
  result: string | null;
  /** 结算摘要（战力/战损/胜负），由 resolve_pvp 写入；pending 行为 null。 */
  resultSummary: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * 发起 1v1 PvP 挑战：先落一条 pending 挑战（RLS 要求挑战者本人插入），
 * 再调 resolve_pvp（SECURITY DEFINER）做服务器权威结算，由该 RPC 复用/结算挑战。
 * 挑战需 target_user_id 落库，故先从 generals 反查目标武将的归属用户。
 */
export async function initiateChallenge(
  userId: string,
  challengerGeneralId: string,
  targetGeneralId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data: target, error: tErr } = await client
    .from('generals')
    .select('user_id')
    .eq('id', targetGeneralId)
    .maybeSingle();
  if (tErr) throw new Error(`发起挑战失败：${tErr.message}`);
  if (!target) throw new Error('发起挑战失败：目标武将不存在');

  const { data: inserted, error } = await client
    .from('challenges')
    .insert({
      id: crypto.randomUUID(),
      challenger_user_id: userId,
      target_user_id: target.user_id,
      challenger_general_id: challengerGeneralId,
      target_general_id: targetGeneralId,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw new Error(`发起挑战失败：${error.message}`);
  const insertedId = inserted?.id;

  const { error: rpcErr } = await client.rpc('resolve_pvp', {
    p_challenger_general_id: challengerGeneralId,
    p_target_general_id: targetGeneralId,
  });
  if (rpcErr) {
    // RPC 失败时回滚刚插入的 pending 行，避免孤儿挑战一直出现在挑战列表。
    // RLS 允许本人删除自己插入的挑战，删除失败则放弃（best-effort），照常抛原始 RPC 错误。
    if (insertedId) {
      // 回滚 pending 行：RLS 允许本人删除自己插入的挑战（challenges_delete 策略）。
      // 删除失败不掩盖原始 RPC 错误，仅告警（best-effort），避免静默吞掉回滚失败。
      const { error: delErr } = await client.from('challenges').delete().eq('id', insertedId);
      if (delErr) {
        console.warn(`回滚失败：无法删除挑战 ${insertedId}：${delErr.message}`);
      }
    }
    throw new Error(`结算挑战失败：${rpcErr.message}`);
  }
}

/** 攻城记录领域对象。camelCase 字段映射 sieges 表 snake_case 列。 */
export interface Siege {
  id: string;
  attackerUserId: string;
  targetCityId: string;
  status: string;
  result: string | null;
  createdAt: string;
}

/**
 * 发起攻城：先落一条 pending sieges 行（RLS 要求攻击方本人插入），
 * 再调 resolve_siege（SECURITY DEFINER）做服务器权威结算，由该 RPC 复用/结算该行。
 */
export async function initiateSiege(
  userId: string,
  attackerGeneralId: string,
  targetCityId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { data: inserted, error } = await client
    .from('sieges')
    .insert({
      id: crypto.randomUUID(),
      attacker_user_id: userId,
      target_city_id: targetCityId,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw new Error(`发起攻城失败：${error.message}`);
  const insertedId = inserted?.id;

  const { error: rpcErr } = await client.rpc('resolve_siege', {
    p_attacker_general_id: attackerGeneralId,
    p_target_city_id: targetCityId,
  });
  if (rpcErr) {
    // RPC 失败时回滚刚插入的 pending 行，避免孤儿攻城一直出现在列表。
    // RLS 允许本人删除自己插入的 sieges 行，删除失败则放弃（best-effort），照常抛原始 RPC 错误。
    if (insertedId) {
      const { error: delErr } = await client.from('sieges').delete().eq('id', insertedId);
      if (delErr) {
        console.warn(`回滚失败：无法删除攻城记录 ${insertedId}：${delErr.message}`);
      }
    }
    throw new Error(`结算攻城失败：${rpcErr.message}`);
  }
}

/** 读取本人发起的攻城记录，按创建时间倒序。 */
export async function fetchSieges(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<Siege[]> {
  const { data, error } = await client
    .from('sieges')
    .select('id,attacker_user_id,target_city_id,status,result,created_at')
    .eq('attacker_user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`读取攻城记录失败：${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    attackerUserId: r.attacker_user_id,
    targetCityId: r.target_city_id,
    status: r.status,
    result: r.result,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** 读取与本人相关（作为挑战者或被挑战者）的挑战，按创建时间倒序。 */
export async function fetchChallenges(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<Challenge[]> {
  const { data, error } = await client
    .from('challenges')
    .select('id,challenger_user_id,target_user_id,status,result,result_summary,created_at')
    .or(`challenger_user_id.eq.${userId},target_user_id.eq.${userId}`)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`读取挑战失败：${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    challengerUserId: r.challenger_user_id,
    targetUserId: r.target_user_id,
    status: r.status,
    result: r.result,
    resultSummary: (r.result_summary as Record<string, unknown> | null) ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
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
  /** 打野胜利额外掉落的粮草/铁材/金币（按守军强度换算） */
  droppedFood: number;
  droppedIron: number;
  droppedGold: number;
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
    await updateResources(
      userId,
      { rare: report.droppedRare, food: report.droppedFood, iron: report.droppedIron, gold: report.droppedGold },
      client,
    );
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

/** 设置昵称：按 user_id 幂等 upsert profiles（存量无行也能写入）。 */
export async function setNickname(
  userId: string,
  nickname: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client
    .from('profiles')
    .upsert({ user_id: userId, username: nickname }, { onConflict: 'user_id' });
  if (error) throw new Error(`设置昵称失败：${error.message}`);
}

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
// 管理后台
// ---------------------------------------------------------------------------

/** 读取用户是否为管理员（profiles.is_admin）；无建档或无标志返回 false。 */
export async function fetchIsAdmin(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<boolean> {
  const { data, error } = await client
    .from('profiles')
    .select('is_admin')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取管理员状态失败：${error.message}`);
  return data?.is_admin ?? false;
}

/** 列出全部用户及养成概览（admin_list_users 返回 jsonb 数组）；无数据返回 []。 */
export async function adminListUsers(
  client: SupabaseClient = supabase,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.rpc('admin_list_users');
  if (error) throw new Error(`读取用户列表失败：${error.message}`);
  return Array.isArray(data) ? data : [];
}

/** 调整用户（最早一名）武将的等级/星级。 */
export async function adminSetGeneral(
  userId: string,
  level: number,
  stars: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_general', { p_user_id: userId, p_level: level, p_stars: stars });
  if (error) throw new Error(`调整武将失败：${error.message}`);
}

/** 调整用户（最早一件）武器的阶。 */
export async function adminSetWeaponTier(
  userId: string,
  tier: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_weapon_tier', { p_user_id: userId, p_tier: tier });
  if (error) throw new Error(`调整武器失败：${error.message}`);
}

/** 设置用户部队最高兵种解锁等级。 */
export async function adminSetTroopUnlock(
  userId: string,
  maxLevel: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_troop_unlock', { p_user_id: userId, p_max_level: maxLevel });
  if (error) throw new Error(`调整兵种解锁失败：${error.message}`);
}

/** 按增量调整用户四项资源（可负，下限 0）。 */
export async function adminAdjustResources(
  userId: string,
  food: number,
  iron: number,
  rare: number,
  gold: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_adjust_resources', {
    p_user_id: userId,
    p_food: food,
    p_iron: iron,
    p_rare: rare,
    p_gold: gold,
  });
  if (error) throw new Error(`调整资源失败：${error.message}`);
}

/** 修改用户昵称。 */
export async function adminSetNickname(
  userId: string,
  nickname: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_nickname', { p_user_id: userId, p_nickname: nickname });
  if (error) throw new Error(`修改昵称失败：${error.message}`);
}

/** 授予/撤销用户管理员标志。 */
export async function adminSetAdmin(
  userId: string,
  isAdmin: boolean,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_admin', { p_user_id: userId, p_is_admin: isAdmin });
  if (error) throw new Error(`调整管理员失败：${error.message}`);
}

/** 读取全部游戏参数（admin_get_params 返回 jsonb 对象）；无数据返回 {}。 */
export async function adminGetParams(
  client: SupabaseClient = supabase,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc('admin_get_params');
  if (error) throw new Error(`读取游戏参数失败：${error.message}`);
  return (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
}

/** 设置单条游戏参数（upsert）。 */
export async function adminSetParam(
  key: string,
  value: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_param', { p_key: key, p_value: value });
  if (error) throw new Error(`设置游戏参数失败：${error.message}`);
}

/** 重设用户免战期（小时；0 表示立即结束）。 */
export async function adminSetPeaceProtection(
  userId: string,
  hours: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_peace_protection', { p_user_id: userId, p_hours: hours });
  if (error) throw new Error(`设置免战期失败：${error.message}`);
}

/** 删除用户及其全部关联数据（服务器级联）；不能删除管理员自己。 */
export async function adminDeleteUser(
  userId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_delete_user', { p_user_id: userId });
  if (error) throw new Error(`删除用户失败：${error.message}`);
}

/** 管理端军团成员。 */
export interface AdminGuildMember {
  userId: string;
  nickname: string | null;
}

/** 管理端军团领域对象。 */
export interface AdminGuild {
  id: string;
  name: string;
  leaderUserId: string;
  leaderNickname: string | null;
  memberCount: number;
  members: AdminGuildMember[];
  createdAt: string;
}

/** 列出全部军团及成员数、盟主昵称、成员列表（admin_list_guilds 返回 jsonb 数组）。 */
export async function adminListGuilds(
  client: SupabaseClient = supabase,
): Promise<AdminGuild[]> {
  const { data, error } = await client.rpc('admin_list_guilds');
  if (error) throw new Error(`读取军团列表失败：${error.message}`);
  return Array.isArray(data)
    ? (data as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        leaderUserId: r.leader_user_id as string,
        leaderNickname: (r.leader_nickname as string | null) ?? null,
        memberCount: Number(r.member_count ?? 0),
        members: Array.isArray(r.members)
          ? (r.members as Record<string, unknown>[]).map((m) => ({
              userId: m.user_id as string,
              nickname: (m.nickname as string | null) ?? null,
            }))
          : [],
        createdAt: new Date(r.created_at as string).toISOString(),
      }))
    : [];
}

/** 重命名军团。 */
export async function adminRenameGuild(
  guildId: string,
  name: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_rename_guild', { p_guild_id: guildId, p_name: name });
  if (error) throw new Error(`重命名军团失败：${error.message}`);
}

/** 解散军团（成员行级联删除）。 */
export async function adminDeleteGuild(
  guildId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_delete_guild', { p_guild_id: guildId });
  if (error) throw new Error(`解散军团失败：${error.message}`);
}

/** 将某用户移出某军团。 */
export async function adminKickGuildMember(
  guildId: string,
  userId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_kick_guild_member', { p_guild_id: guildId, p_user_id: userId });
  if (error) throw new Error(`移除军团成员失败：${error.message}`);
}

/** 将某用户加入某军团（仅限未入团用户）。 */
export async function adminAddGuildMember(
  guildId: string,
  userId: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_add_guild_member', { p_guild_id: guildId, p_user_id: userId });
  if (error) throw new Error(`添加军团成员失败：${error.message}`);
}

/** 重置用户行动点数（可设具体值，刷新恢复起点）。 */
export async function adminSetActionPoints(
  userId: string,
  current: number,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.rpc('admin_set_action_points', { p_user_id: userId, p_current: current });
  if (error) throw new Error(`重置行动点失败：${error.message}`);
}

// ---------------------------------------------------------------------------
// 私有辅助
// ---------------------------------------------------------------------------

/** 数据库 guilds 行 → Guild。 */
function toGuild(row: Record<string, unknown>): Guild {
  return {
    id: row.id as string,
    name: row.name as string,
    leaderUserId: row.leader_user_id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

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
