-- MyGame 增量升级脚本（对已有库幂等，可重复运行）
-- 包含：RLS 可见性 / 世界播种 / 军团 / 挑战(PvP)

-- =============================================================
-- 免战期新手保护（与 schema.sql 保持一致）
-- =============================================================
-- 已有库补齐 progression 上的免战期列（幂等，可重复执行）
ALTER TABLE progression ADD COLUMN IF NOT EXISTS
  peace_protection_until timestamptz;

-- 为既有老用户补发 24 小时免战期（幂等：只补 NULL 行）。
-- 新建用户的免战期由 seed_new_user 触发（见 schema.sql），
-- 此处仅覆盖升级前已存在的用户。
UPDATE progression
   SET peace_protection_until = now() + interval '24 hours'
 WHERE peace_protection_until IS NULL;

-- =============================================================
-- 昵称：与 schema.sql 保持一致
-- =============================================================
-- profiles SELECT 放开：登录用户即可读全部昵称（军团成员间互看昵称）。
-- 注意：schema.sql 里 seed_new_user 在建号时播种昵称；upgrade.sql 不重定义该触发器，
-- 故对升级前已存在的用户用下方幂等 INSERT 回填 profiles 行。
-- 默认昵称仅 6 位十六进制（约 1600 万种），极端并发下可能撞唯一键，故用 ON CONFLICT 跳过。
DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 为既有老用户补发昵称（幂等：仅补缺行，撞唯一键则跳过，不覆盖已有昵称）
INSERT INTO profiles (user_id, username)
SELECT u.id, '玩家' || left(u.id::text, 6)
  FROM auth.users u
 WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id)
ON CONFLICT (user_id) DO NOTHING;

-- [1] RLS：开放 generals/cities 共享可见
DROP POLICY IF EXISTS generals_select ON generals;
CREATE POLICY generals_select ON generals
  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS cities_select ON cities;
CREATE POLICY cities_select ON cities
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- [2] 世界内容播种（地形 + 野地）
CREATE OR REPLACE FUNCTION seed_world_content(p_world_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_w integer;
  v_h integer;
  v_x integer;
  v_y integer;
  v_terrain text;
  v_hash bigint;
BEGIN
  SELECT width, height INTO v_w, v_h FROM worlds WHERE id = p_world_id;
  IF v_w IS NULL OR v_h IS NULL THEN RETURN; END IF;
  -- 已有地形则跳过（幂等，避免重复播种）
  IF EXISTS (SELECT 1 FROM world_tiles WHERE world_id = p_world_id LIMIT 1) THEN
    RETURN;
  END IF;
  -- 地形网格：按 (x,y) 确定性哈希映射到 g(平原)/f(林地)/m(山地)/w(水域)
  FOR v_y IN 1..v_h LOOP
    FOR v_x IN 1..v_w LOOP
      v_hash := abs(hashtext(p_world_id || ':' || v_x || ',' || v_y)::bigint) % 100;
      v_terrain := CASE
        WHEN v_hash <= 55 THEN 'g'
        WHEN v_hash <= 75 THEN 'f'
        WHEN v_hash <= 88 THEN 'm'
        ELSE 'w'
      END;
      INSERT INTO world_tiles (world_id, x, y, terrain)
      VALUES (p_world_id, v_x, v_y, v_terrain);
    END LOOP;
  END LOOP;
  -- 撒野地（多难度，攻破后按 WILDLAND_REFRESH_MS 刷新）
  INSERT INTO wildlands (id, world_id, x, y, name, strength, drop)
  SELECT
    gen_random_uuid()::text, p_world_id, x, y, name, strength, GREATEST(1, round(strength/10))
  FROM (VALUES
    ( 3, 3,'山贼营地', 10),
    ( 8, 6,'强盗窝',  15),
    (12, 4,'流寇寨',  20),
    (16, 9,'悍匪堡',  30),
    ( 6,11,'贼首营寨', 40),
    (14,12,'巨寇巢穴', 50)
  ) AS w(x, y, name, strength);
END;
$$;

-- [3] 军团表 + RLS
CREATE TABLE IF NOT EXISTS guilds (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  leader_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id),
  UNIQUE (user_id)  -- 单军团：一名玩家只属于一个军团
);

ALTER TABLE guilds ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_members ENABLE ROW LEVEL SECURITY;

-- guilds：登录用户可读全部；创建任意登录用户；改名/解散仅 leader
DROP POLICY IF EXISTS guilds_select ON guilds;
CREATE POLICY guilds_select ON guilds FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS guilds_insert ON guilds;
CREATE POLICY guilds_insert ON guilds
  FOR INSERT WITH CHECK (auth.uid() = leader_user_id);
DROP POLICY IF EXISTS guilds_update ON guilds;
CREATE POLICY guilds_update ON guilds
  FOR UPDATE USING (auth.uid() = leader_user_id) WITH CHECK (auth.uid() = leader_user_id);
DROP POLICY IF EXISTS guilds_delete ON guilds;
CREATE POLICY guilds_delete ON guilds
  FOR DELETE USING (auth.uid() = leader_user_id);

-- guild_members：登录用户可读全部；加入/退出仅本人
DROP POLICY IF EXISTS guild_members_select ON guild_members;
CREATE POLICY guild_members_select ON guild_members
  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS guild_members_insert ON guild_members;
CREATE POLICY guild_members_insert ON guild_members
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS guild_members_delete ON guild_members;
CREATE POLICY guild_members_delete ON guild_members
  FOR DELETE USING (auth.uid() = user_id);

-- =============================================================
-- 17. PvP 挑战（1v1）：发起/结算/取消，结算由 SECURITY DEFINER RPC 写入

-- [4] 挑战系统（challenges/troop_stats/pvp 表 + resolve_pvp RPC + 策略）
CREATE TABLE IF NOT EXISTS challenges (
  id text PRIMARY KEY,
  challenger_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenger_general_id text REFERENCES generals(id),
  target_general_id text REFERENCES generals(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  result text CHECK (result IN ('challenger_win','challenger_lose','draw')),
  -- 结算摘要：战力/战损/胜负（由 resolve_pvp RPC 写入；pending 行为 NULL）
  result_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
-- 双方（挑战者/被挑战者）可读自己的挑战；发起者写；结算由 RPC（SECURITY DEFINER）写
DROP POLICY IF EXISTS challenges_select ON challenges;
CREATE POLICY challenges_select ON challenges
  FOR SELECT USING (auth.uid() IN (challenger_user_id, target_user_id));
DROP POLICY IF EXISTS challenges_insert ON challenges;
CREATE POLICY challenges_insert ON challenges
  FOR INSERT WITH CHECK (auth.uid() = challenger_user_id);
-- 挑战者本人可删除自己的挑战：供 initiateChallenge 在 RPC 结算失败时回滚 pending 行。
-- 若无此策略，回滚 delete 会被 RLS 拒绝（且错误被吞掉），孤儿挑战无法清理。
DROP POLICY IF EXISTS challenges_delete ON challenges;
CREATE POLICY challenges_delete ON challenges
  FOR DELETE USING (auth.uid() = challenger_user_id);

-- =============================================================
-- 18. 兵种单兵战力表（1-15 级）：供 SECURITY DEFINER RPC 查询
-- =============================================================
-- 本表镜像 shared/src/troops.ts 的 TROOP_CATALOG（单兵 power）。
-- 单一数据源是 shared/src/troops.ts；troop_stats 是给 RPC 用的 SQL 侧副本，改动须两边同步。
CREATE TABLE IF NOT EXISTS troop_stats (
  soldier_level integer PRIMARY KEY,
  power integer NOT NULL
);
INSERT INTO troop_stats (soldier_level, power) VALUES
  (1, 1),
  (2, 2),
  (3, 3),
  (4, 4),
  (5, 5),
  (6, 6),
  (7, 7),
  (8, 8),
  (9, 9),
  (10, 10),
  (11, 11),
  (12, 12),
  (13, 13),
  (14, 14),
  (15, 15);

-- =============================================================
-- 19. PvP 战斗记录（battle_instances/battle_reports 为野地 PvE 专用：
--     二者含 NOT NULL 野地外键与野地回写 RLS，无法承载 1v1 PvP，
--     故为 PvP 另建一对表。均只读，写入由 resolve_pvp（SECURITY DEFINER）负责）
-- =============================================================
CREATE TABLE IF NOT EXISTS pvp_battle_instances (
  id text PRIMARY KEY,
  challenger_general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  target_general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  challenger_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenger_power integer NOT NULL,
  target_power integer NOT NULL,
  winner text CHECK (winner IN ('challenger','target')),  -- NULL 表示平局
  challenger_casualties integer NOT NULL,
  target_casualties integer NOT NULL,
  result text NOT NULL CHECK (result IN ('challenger_win','challenger_lose','draw')),
  log jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pvp_battle_reports (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  battle_instance_id text NOT NULL REFERENCES pvp_battle_instances(id) ON DELETE CASCADE,
  opponent_general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  victory boolean NOT NULL,
  attacker_casualties integer NOT NULL,
  defender_casualties integer NOT NULL,
  log jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pvp_battle_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE pvp_battle_reports ENABLE ROW LEVEL SECURITY;

-- 双方（挑战者/被挑战者）可读战斗记录；写入由 SECURITY DEFINER RPC 完成
DROP POLICY IF EXISTS pvp_battle_instances_select ON pvp_battle_instances;
CREATE POLICY pvp_battle_instances_select ON pvp_battle_instances
  FOR SELECT USING (auth.uid() IN (challenger_user_id, target_user_id));
-- 每名玩家只读自己的战报
DROP POLICY IF EXISTS pvp_battle_reports_select ON pvp_battle_reports;
CREATE POLICY pvp_battle_reports_select ON pvp_battle_reports
  FOR SELECT USING (auth.uid() = user_id);

-- =============================================================
-- 20. resolve_pvp：1v1 PvP 服务器权威战斗结算（SECURITY DEFINER）
-- =============================================================
-- SECURITY DEFINER 以函数所有者（postgres/supabase_admin）身份执行，
-- 绕过 RLS，从而可同时原子更新双方 army_units / challenges / pvp 记录。
-- 公式镜像 shared/src/combat.ts：
--   generalMultiplier(level, stars) = 1 + (level-1)*0.05 + (stars-1)*0.10
--   armyPower = SUM(count × troop_stats.power)
--   weaponBonus = cappedWeaponTier × 50（无武器为 0；有效阶由部队最高兵种等级封顶，
--                与 shared/src/combat.ts 的 effectiveWeaponTier 一致，PvE/PvP 统一）
--   generalSidePower = generalMultiplier × armyPower + weaponBonus
--   winProbability = 1/(1+exp(-slope*ln(attacker/defender))), slope=2.0
--   胜方轻损 15%、败方重损 70%（战损 = floor(侧总兵数×rate)，按行成比例分配）
-- 胜负判定：完全均势 → 平局；否则用「双方 id + 挑战 id」哈希做确定性种子，
-- 模拟 combat.ts 的 mulberry32 种子随机（rand < winProbability）。
-- 注：plpgsql 函数内不允许显式 COMMIT/ROLLBACK，EXCEPTION 子句会为函数
-- 主体建立子事务，异常时自动回滚并重抛，保证整体原子性。
-- 战损分配：先对侧总兵数向下取整（floor(total×rate)，与 combat.ts 一致），
-- 再按各兵堆占比成比例分配到每行；余数补给小数部分最大的兵堆，保证合计等于总数战损。
CREATE OR REPLACE FUNCTION allocate_casualties(p_general_id text, p_rate numeric)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ids text[];
  v_counts integer[];
  v_lost integer[];
  v_frac numeric[];
  v_cap integer[];
  v_rows integer;
  v_i integer;
  v_best integer;
  v_max_frac numeric;
  v_total integer;
  v_total_lost integer;
  v_sum0 integer := 0;
  v_remainder integer;
BEGIN
  SELECT COALESCE(SUM(count), 0) INTO v_total FROM army_units WHERE general_id = p_general_id;
  IF v_total <= 0 OR p_rate <= 0 THEN
    RETURN 0;
  END IF;
  v_total_lost := floor(v_total * p_rate)::integer;

  -- 取行并存数组（id 升序保证确定性）
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM army_units WHERE general_id = p_general_id;
  SELECT array_agg(count ORDER BY id) INTO v_counts FROM army_units WHERE general_id = p_general_id;
  v_rows := array_length(v_ids, 1);
  v_lost := array_fill(0, ARRAY[v_rows]);
  v_frac := array_fill(0, ARRAY[v_rows])::numeric[];
  v_cap := array_fill(0, ARRAY[v_rows]);

  -- 第一遍：每行向下取整 + 记录小数部分与剩余兵力
  FOR v_i IN 1..v_rows LOOP
    v_lost[v_i] := floor(v_counts[v_i] * p_rate)::integer;
    v_frac[v_i] := v_counts[v_i] * p_rate - v_lost[v_i];
    v_cap[v_i] := v_counts[v_i] - v_lost[v_i];
    v_sum0 := v_sum0 + v_lost[v_i];
  END LOOP;

  -- 余数 = 总数战损 - 各行向下取整之和（恒 ≥ 0），补给小数部分最大的行
  v_remainder := v_total_lost - v_sum0;
  WHILE v_remainder > 0 LOOP
    v_best := 0;
    v_max_frac := -1;
    FOR v_i IN 1..v_rows LOOP
      IF v_cap[v_i] > 0 AND v_frac[v_i] > v_max_frac THEN
        v_max_frac := v_frac[v_i];
        v_best := v_i;
      END IF;
    END LOOP;
    IF v_best = 0 THEN
      EXIT;
    END IF;
    v_lost[v_best] := v_lost[v_best] + 1;
    v_cap[v_best] := v_cap[v_best] - 1;
    v_frac[v_best] := -1;  -- 已补，避免重复选中
    v_remainder := v_remainder - 1;
  END LOOP;

  -- 第二遍：落库（战损 ≥ 原数则删行，否则减 count）
  FOR v_i IN 1..v_rows LOOP
    IF v_lost[v_i] >= v_counts[v_i] THEN
      DELETE FROM army_units WHERE id = v_ids[v_i];
    ELSIF v_lost[v_i] > 0 THEN
      UPDATE army_units SET count = v_counts[v_i] - v_lost[v_i] WHERE id = v_ids[v_i];
    END IF;
  END LOOP;

  RETURN v_total_lost;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_pvp(
  p_challenger_general_id text,
  p_target_general_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  -- 挑战者武将
  v_ch_user uuid;
  v_ch_level integer;
  v_ch_stars integer;
  v_ch_weapon_id text;
  -- 目标武将
  v_tg_user uuid;
  v_tg_level integer;
  v_tg_stars integer;
  v_tg_weapon_id text;
  -- 战力计算
  v_ch_army numeric;
  v_tg_army numeric;
  v_ch_weapon_tier integer;
  v_tg_weapon_tier integer;
  -- 部队最高兵种等级（用于封顶武器有效阶，镜像 effectiveWeaponTier）
  v_ch_max_level integer;
  v_tg_max_level integer;
  v_ch_mult numeric;
  v_tg_mult numeric;
  v_ch_power numeric;
  v_tg_power numeric;
  v_win_prob numeric;
  v_seed bigint;
  v_rand numeric;
  v_attacker_won boolean;
  v_result text;
  v_winner text;
  v_ch_rate numeric;
  v_tg_rate numeric;
  -- 挑战记录
  v_challenge_id text;
  -- 免战期校验：目标是否处于新手保护期
  v_tg_protection timestamptz;
  -- 防刷：同目标冷却 + 行动点门槛
  v_last_challenge_at timestamptz;
  v_ap_current integer;
  v_ap_max integer;
  v_ap_last timestamptz;
  v_ap_elapsed numeric;
  v_ap_periods integer;
  v_ap_new_last timestamptz;
  -- 战损统计（总额，由 allocate_casualties 计算）
  v_ch_casualties integer := 0;
  v_tg_casualties integer := 0;
  -- 战斗记录
  v_battle_id text;
  v_log jsonb;
  v_summary jsonb;
  v_ch_power_int integer;
  v_tg_power_int integer;
BEGIN
  -- 1. 校验：登录态 + 双方武将存在 + 归属 + 非自挑战
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 未登录';
  END IF;
  IF p_challenger_general_id = p_target_general_id THEN
    RAISE EXCEPTION 'resolve_pvp: 不能挑战自己的武将';
  END IF;

  SELECT user_id, level, stars, weapon_id
    INTO v_ch_user, v_ch_level, v_ch_stars, v_ch_weapon_id
    FROM generals
   WHERE id = p_challenger_general_id;
  IF v_ch_user IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 挑战者武将不存在 %', p_challenger_general_id;
  END IF;
  IF v_ch_user <> v_caller THEN
    RAISE EXCEPTION 'resolve_pvp: 无权以他人武将发起挑战';
  END IF;

  SELECT user_id, level, stars, weapon_id
    INTO v_tg_user, v_tg_level, v_tg_stars, v_tg_weapon_id
    FROM generals
   WHERE id = p_target_general_id;
  IF v_tg_user IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 目标武将不存在 %', p_target_general_id;
  END IF;

  -- 1a. 自挑战拦截：同一用户麾下的任意武将均不可作为目标（不止相同的 general id）
  IF v_tg_user = v_caller THEN
    RAISE EXCEPTION 'resolve_pvp: 不能挑战自己的武将';
  END IF;

  -- 1a'. 免战期校验：目标仍处于新手保护期则拒绝挑战（先于冷却/扣行动点，避免白费行动点）
  SELECT peace_protection_until INTO v_tg_protection
    FROM progression
   WHERE user_id = v_tg_user;
  IF v_tg_protection IS NOT NULL AND v_tg_protection > now() THEN
    RAISE EXCEPTION '对方处于免战期，暂时无法挑战';
  END IF;

  -- 1b. 防刷：对同一目标用户的挑战设有冷却（60 秒内不可重复），并扣除行动点
  SELECT created_at INTO v_last_challenge_at
    FROM challenges
   WHERE challenger_user_id = v_caller
     AND target_user_id = v_tg_user
     AND status IN ('pending', 'resolved')
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_last_challenge_at IS NOT NULL
     AND now() - v_last_challenge_at < interval '60 seconds' THEN
    RAISE EXCEPTION 'resolve_pvp: 冷却中，60 秒内不能重复挑战同一目标';
  END IF;

  -- 行动点门槛与扣除（每 10 分钟恢复 1 点；消耗=ACTION_COSTS.challenge=2，
  -- 恢复公式镜像 frontend/src/data.ts 的 spendActionPoints，服务器权威防绕过）
  SELECT current, max, last_recovered_at
    INTO v_ap_current, v_ap_max, v_ap_last
    FROM action_points
   WHERE user_id = v_caller;
  IF v_ap_current IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 行动力数据不存在';
  END IF;
  v_ap_elapsed := EXTRACT(EPOCH FROM (now() - v_ap_last));
  v_ap_periods := floor(v_ap_elapsed / 600)::integer;  -- 600 秒 = 10 分钟恢复 1 点
  IF v_ap_current + v_ap_periods < 2 THEN
    RAISE EXCEPTION 'resolve_pvp: 行动点不足';
  END IF;
  v_ap_new_last := v_ap_last + make_interval(secs => v_ap_periods * 600);
  UPDATE action_points
     SET current = LEAST(v_ap_max, v_ap_current + v_ap_periods) - 2,
         last_recovered_at = v_ap_new_last
   WHERE user_id = v_caller;

  -- 2. 复用或新建双方 pending 挑战（同一方向尚无 pending 则补建一条）
  SELECT id INTO v_challenge_id
    FROM challenges
   WHERE challenger_general_id = p_challenger_general_id
     AND target_general_id = p_target_general_id
     AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_challenge_id IS NULL THEN
    INSERT INTO challenges (id, challenger_user_id, target_user_id, challenger_general_id, target_general_id, status)
    VALUES (gen_random_uuid()::text, v_ch_user, v_tg_user, p_challenger_general_id, p_target_general_id, 'pending')
    RETURNING id INTO v_challenge_id;
  END IF;

  -- 3. 战力：armyPower = SUM(count × troop_stats.power)
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0)
    INTO v_ch_army
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_challenger_general_id;
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0)
    INTO v_tg_army
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_target_general_id;

  -- 武器阶（原始 tier），随后用部队最高兵种等级封顶（effectiveWeaponTier）
  SELECT tier INTO v_ch_weapon_tier FROM weapons WHERE id = v_ch_weapon_id;
  SELECT tier INTO v_tg_weapon_tier FROM weapons WHERE id = v_tg_weapon_id;

  -- 部队最高兵种等级：封顶武器有效阶，防止高阶武器挂低阶兵时 PvP 战力高于 PvE。
  -- 镜像 shared/src/combat.ts 的 effectiveWeaponTier（无兵或没武器时有效阶为 0）。
  SELECT COALESCE(MAX(soldier_level), 0) INTO v_ch_max_level
    FROM army_units WHERE general_id = p_challenger_general_id;
  SELECT COALESCE(MAX(soldier_level), 0) INTO v_tg_max_level
    FROM army_units WHERE general_id = p_target_general_id;
  IF v_ch_weapon_tier IS NOT NULL AND v_ch_max_level > 0 THEN
    v_ch_weapon_tier := LEAST(v_ch_weapon_tier, v_ch_max_level);
  ELSE
    v_ch_weapon_tier := NULL;
  END IF;
  IF v_tg_weapon_tier IS NOT NULL AND v_tg_max_level > 0 THEN
    v_tg_weapon_tier := LEAST(v_tg_weapon_tier, v_tg_max_level);
  ELSE
    v_tg_weapon_tier := NULL;
  END IF;

  -- generalMultiplier = 1 + (level-1)*0.05 + (stars-1)*0.10
  v_ch_mult := 1 + (v_ch_level - 1) * 0.05 + (v_ch_stars - 1) * 0.10;
  v_tg_mult := 1 + (v_tg_level - 1) * 0.05 + (v_tg_stars - 1) * 0.10;

  -- generalSidePower = multiplier × armyPower + weaponBonus（每阶 +50，用封顶后的有效阶）
  v_ch_power := v_ch_mult * v_ch_army + COALESCE(v_ch_weapon_tier, 0) * 50;
  v_tg_power := v_tg_mult * v_tg_army + COALESCE(v_tg_weapon_tier, 0) * 50;

  -- 4. 胜率：winProbability（logistic，slope=2.0；含 combat.ts 边界情况）
  IF v_tg_power <= 0 THEN
    v_win_prob := CASE WHEN v_ch_power <= 0 THEN 0.5 ELSE 1 END;
  ELSIF v_ch_power <= 0 THEN
    v_win_prob := 0;
  ELSE
    v_win_prob := 1 / (1 + exp(-2.0 * ln(v_ch_power / v_tg_power)));
  END IF;

  -- 5. 胜负判定：完全均势 → 平局；否则种子随机驱动胜率（rand < winProb）
  IF v_ch_power = v_tg_power THEN
    v_result := 'draw';
    v_winner := NULL;
    v_attacker_won := NULL;
  ELSE
    v_seed := abs(hashtext(p_challenger_general_id || '|' || p_target_general_id || '|' || v_challenge_id)::bigint);
    v_rand := (v_seed % 1000000) / 1000000.0;
    v_attacker_won := v_rand < v_win_prob;
    IF v_attacker_won THEN
      v_result := 'challenger_win';
      v_winner := 'challenger';
    ELSE
      v_result := 'challenger_lose';
      v_winner := 'target';
    END IF;
  END IF;

  -- 6. 战损率：胜方 15%、败方 70%；平局无战损
  IF v_result = 'draw' THEN
    v_ch_rate := 0;
    v_tg_rate := 0;
  ELSIF v_attacker_won THEN
    v_ch_rate := 0.15;
    v_tg_rate := 0.70;
  ELSE
    v_ch_rate := 0.70;
    v_tg_rate := 0.15;
  END IF;

  -- 6b. 战损：对「侧总兵数」向下取整后按各兵堆占比成比例分配（与 combat.ts 一致，
  --     而非逐行向下取整）。allocate_casualties 返回该侧总战损（= floor(总数×战损率)）。
  v_ch_casualties := allocate_casualties(p_challenger_general_id, v_ch_rate);
  v_tg_casualties := allocate_casualties(p_target_general_id, v_tg_rate);

  -- 7. 写 PvP 战斗记录 + 双方战报（每名玩家各一条）
  v_ch_power_int := round(v_ch_power)::integer;
  v_tg_power_int := round(v_tg_power)::integer;
  v_log := jsonb_build_object(
    'challenger', jsonb_build_object('general_id', p_challenger_general_id, 'power', v_ch_power_int, 'casualties', v_ch_casualties),
    'target', jsonb_build_object('general_id', p_target_general_id, 'power', v_tg_power_int, 'casualties', v_tg_casualties),
    'win_prob', round(v_win_prob::numeric, 4),
    'result', v_result
  );

  INSERT INTO pvp_battle_instances (id, challenger_general_id, target_general_id, challenger_user_id, target_user_id, challenger_power, target_power, winner, challenger_casualties, target_casualties, result, log, created_at)
  VALUES (gen_random_uuid()::text, p_challenger_general_id, p_target_general_id, v_ch_user, v_tg_user, v_ch_power_int, v_tg_power_int, v_winner, v_ch_casualties, v_tg_casualties, v_result, v_log, now())
  RETURNING id INTO v_battle_id;

  -- 挑战者战报：victory = 挑战者胜
  INSERT INTO pvp_battle_reports (id, user_id, general_id, battle_instance_id, opponent_general_id, victory, attacker_casualties, defender_casualties, log, created_at)
  VALUES (gen_random_uuid()::text, v_ch_user, p_challenger_general_id, v_battle_id, p_target_general_id, COALESCE(v_attacker_won, false), v_ch_casualties, v_tg_casualties, v_log, now());
  -- 目标战报：victory = 挑战者败
  INSERT INTO pvp_battle_reports (id, user_id, general_id, battle_instance_id, opponent_general_id, victory, attacker_casualties, defender_casualties, log, created_at)
  VALUES (gen_random_uuid()::text, v_tg_user, p_target_general_id, v_battle_id, p_challenger_general_id, COALESCE(NOT v_attacker_won, false), v_ch_casualties, v_tg_casualties, v_log, now());

  -- 8. 更新挑战状态为已结算，并把战力/战损摘要写入 result_summary 供前端展示
  v_summary := jsonb_build_object(
    'challenge_id', v_challenge_id,
    'battle_instance_id', v_battle_id,
    'result', v_result,
    'winner', v_winner,
    'attacker', jsonb_build_object('general_id', p_challenger_general_id, 'power', v_ch_power_int, 'casualties', v_ch_casualties),
    'defender', jsonb_build_object('general_id', p_target_general_id, 'power', v_tg_power_int, 'casualties', v_tg_casualties)
  );
  UPDATE challenges SET status = 'resolved', result = v_result, result_summary = v_summary, resolved_at = now()
   WHERE id = v_challenge_id;

  -- 9. 返回摘要
  RETURN v_summary;

EXCEPTION WHEN OTHERS THEN
  -- 子事务自动回滚后重抛，保证整体原子性
  RAISE;
END;
$$;

-- [5] 野地刷新（攻破 5 分钟后重现）
CREATE OR REPLACE FUNCTION refresh_wildlands(p_world_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE wildlands
  SET defeated_at = NULL
  WHERE world_id = p_world_id
    AND defeated_at IS NOT NULL
    AND defeated_at < now() - interval '5 minutes';
END;
$$;

-- [6] 攻城（sieges 表 + resolve_siege RPC）

SELECT seed_world_content('w-default'); -- 幂等：给现有世界补地形/野地（已有则跳过）

CREATE TABLE IF NOT EXISTS sieges (
  id text PRIMARY KEY,
  attacker_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_city_id text NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  result text CHECK (result IN ('attacker_win','attacker_lose')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE sieges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sieges_select ON sieges;
CREATE POLICY sieges_select ON sieges FOR SELECT USING (
  auth.uid() IN (
    attacker_user_id,
    (SELECT owner_user_id FROM cities WHERE id = target_city_id)
  )
);
DROP POLICY IF EXISTS sieges_insert ON sieges;
CREATE POLICY sieges_insert ON sieges FOR INSERT WITH CHECK (auth.uid() = attacker_user_id);
DROP POLICY IF EXISTS sieges_delete ON sieges;
CREATE POLICY sieges_delete ON sieges FOR DELETE USING (auth.uid() = attacker_user_id);

-- =============================================================
-- 20. resolve_pvp：1v1 PvP 服务器权威战斗结算（SECURITY DEFINER）
-- =============================================================
-- SECURITY DEFINER 以函数所有者（postgres/supabase_admin）身份执行，
-- 绕过 RLS，从而可同时原子更新双方 army_units / challenges / pvp 记录。
-- 公式镜像 shared/src/combat.ts：
--   generalMultiplier(level, stars) = 1 + (level-1)*0.05 + (stars-1)*0.10
--   armyPower = SUM(count × troop_stats.power)
--   weaponBonus = cappedWeaponTier × 50（无武器为 0；有效阶由部队最高兵种等级封顶，
--                与 shared/src/combat.ts 的 effectiveWeaponTier 一致，PvE/PvP 统一）
--   generalSidePower = generalMultiplier × armyPower + weaponBonus
--   winProbability = 1/(1+exp(-slope*ln(attacker/defender))), slope=2.0
--   胜方轻损 15%、败方重损 70%（战损 = floor(侧总兵数×rate)，按行成比例分配）
-- 胜负判定：完全均势 → 平局；否则用「双方 id + 挑战 id」哈希做确定性种子，
-- 模拟 combat.ts 的 mulberry32 种子随机（rand < winProbability）。
-- 注：plpgsql 函数内不允许显式 COMMIT/ROLLBACK，EXCEPTION 子句会为函数
-- 主体建立子事务，异常时自动回滚并重抛，保证整体原子性。
-- 战损分配：先对侧总兵数向下取整（floor(total×rate)，与 combat.ts 一致），
-- 再按各兵堆占比成比例分配到每行；余数补给小数部分最大的兵堆，保证合计等于总数战损。
CREATE OR REPLACE FUNCTION allocate_casualties(p_general_id text, p_rate numeric)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ids text[];
  v_counts integer[];
  v_lost integer[];
  v_frac numeric[];
  v_cap integer[];
  v_rows integer;
  v_i integer;
  v_best integer;
  v_max_frac numeric;
  v_total integer;
  v_total_lost integer;
  v_sum0 integer := 0;
  v_remainder integer;
BEGIN
  SELECT COALESCE(SUM(count), 0) INTO v_total FROM army_units WHERE general_id = p_general_id;
  IF v_total <= 0 OR p_rate <= 0 THEN
    RETURN 0;
  END IF;
  v_total_lost := floor(v_total * p_rate)::integer;

  -- 取行并存数组（id 升序保证确定性）
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM army_units WHERE general_id = p_general_id;
  SELECT array_agg(count ORDER BY id) INTO v_counts FROM army_units WHERE general_id = p_general_id;
  v_rows := array_length(v_ids, 1);
  v_lost := array_fill(0, ARRAY[v_rows]);
  v_frac := array_fill(0, ARRAY[v_rows])::numeric[];
  v_cap := array_fill(0, ARRAY[v_rows]);

  -- 第一遍：每行向下取整 + 记录小数部分与剩余兵力
  FOR v_i IN 1..v_rows LOOP
    v_lost[v_i] := floor(v_counts[v_i] * p_rate)::integer;
    v_frac[v_i] := v_counts[v_i] * p_rate - v_lost[v_i];
    v_cap[v_i] := v_counts[v_i] - v_lost[v_i];
    v_sum0 := v_sum0 + v_lost[v_i];
  END LOOP;

  -- 余数 = 总数战损 - 各行向下取整之和（恒 ≥ 0），补给小数部分最大的行
  v_remainder := v_total_lost - v_sum0;
  WHILE v_remainder > 0 LOOP
    v_best := 0;
    v_max_frac := -1;
    FOR v_i IN 1..v_rows LOOP
      IF v_cap[v_i] > 0 AND v_frac[v_i] > v_max_frac THEN
        v_max_frac := v_frac[v_i];
        v_best := v_i;
      END IF;
    END LOOP;
    IF v_best = 0 THEN
      EXIT;
    END IF;
    v_lost[v_best] := v_lost[v_best] + 1;
    v_cap[v_best] := v_cap[v_best] - 1;
    v_frac[v_best] := -1;  -- 已补，避免重复选中
    v_remainder := v_remainder - 1;
  END LOOP;

  -- 第二遍：落库（战损 ≥ 原数则删行，否则减 count）
  FOR v_i IN 1..v_rows LOOP
    IF v_lost[v_i] >= v_counts[v_i] THEN
      DELETE FROM army_units WHERE id = v_ids[v_i];
    ELSIF v_lost[v_i] > 0 THEN
      UPDATE army_units SET count = v_counts[v_i] - v_lost[v_i] WHERE id = v_ids[v_i];
    END IF;
  END LOOP;

  RETURN v_total_lost;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_pvp(
  p_challenger_general_id text,
  p_target_general_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  -- 挑战者武将
  v_ch_user uuid;
  v_ch_level integer;
  v_ch_stars integer;
  v_ch_weapon_id text;
  -- 目标武将
  v_tg_user uuid;
  v_tg_level integer;
  v_tg_stars integer;
  v_tg_weapon_id text;
  -- 目标免战期（新手保护）
  v_tg_protection timestamptz;
  -- 战力计算
  v_ch_army numeric;
  v_tg_army numeric;
  v_ch_weapon_tier integer;
  v_tg_weapon_tier integer;
  -- 部队最高兵种等级（用于封顶武器有效阶，镜像 effectiveWeaponTier）
  v_ch_max_level integer;
  v_tg_max_level integer;
  v_ch_mult numeric;
  v_tg_mult numeric;
  v_ch_power numeric;
  v_tg_power numeric;
  v_win_prob numeric;
  v_seed bigint;
  v_rand numeric;
  v_attacker_won boolean;
  v_result text;
  v_winner text;
  v_ch_rate numeric;
  v_tg_rate numeric;
  -- 挑战记录
  v_challenge_id text;
  -- 防刷：同目标冷却 + 行动点门槛
  v_last_challenge_at timestamptz;
  v_ap_current integer;
  v_ap_max integer;
  v_ap_last timestamptz;
  v_ap_elapsed numeric;
  v_ap_periods integer;
  v_ap_new_last timestamptz;
  -- 战损统计（总额，由 allocate_casualties 计算）
  v_ch_casualties integer := 0;
  v_tg_casualties integer := 0;
  -- 战斗记录
  v_battle_id text;
  v_log jsonb;
  v_summary jsonb;
  v_ch_power_int integer;
  v_tg_power_int integer;
BEGIN
  -- 1. 校验：登录态 + 双方武将存在 + 归属 + 非自挑战
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 未登录';
  END IF;
  IF p_challenger_general_id = p_target_general_id THEN
    RAISE EXCEPTION 'resolve_pvp: 不能挑战自己的武将';
  END IF;

  SELECT user_id, level, stars, weapon_id
    INTO v_ch_user, v_ch_level, v_ch_stars, v_ch_weapon_id
    FROM generals
   WHERE id = p_challenger_general_id;
  IF v_ch_user IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 挑战者武将不存在 %', p_challenger_general_id;
  END IF;
  IF v_ch_user <> v_caller THEN
    RAISE EXCEPTION 'resolve_pvp: 无权以他人武将发起挑战';
  END IF;

  SELECT user_id, level, stars, weapon_id
    INTO v_tg_user, v_tg_level, v_tg_stars, v_tg_weapon_id
    FROM generals
   WHERE id = p_target_general_id;
  IF v_tg_user IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 目标武将不存在 %', p_target_general_id;
  END IF;

  -- 1a. 自挑战拦截：同一用户麾下的任意武将均不可作为目标（不止相同的 general id）
  IF v_tg_user = v_caller THEN
    RAISE EXCEPTION 'resolve_pvp: 不能挑战自己的武将';
  END IF;

  -- 1a'. 免战期校验：目标仍处于新手保护期则拒绝挑战（先于冷却/扣行动点，避免白费行动点）
  SELECT peace_protection_until INTO v_tg_protection
    FROM progression
   WHERE user_id = v_tg_user;
  IF v_tg_protection IS NOT NULL AND v_tg_protection > now() THEN
    RAISE EXCEPTION '对方处于免战期，暂时无法挑战';
  END IF;

  -- 1b. 防刷：对同一目标用户的挑战设有冷却（60 秒内不可重复），并扣除行动点
  SELECT created_at INTO v_last_challenge_at
    FROM challenges
   WHERE challenger_user_id = v_caller
     AND target_user_id = v_tg_user
     AND status IN ('pending', 'resolved')
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_last_challenge_at IS NOT NULL
     AND now() - v_last_challenge_at < interval '60 seconds' THEN
    RAISE EXCEPTION 'resolve_pvp: 冷却中，60 秒内不能重复挑战同一目标';
  END IF;

  -- 行动点门槛与扣除（每 10 分钟恢复 1 点；消耗=ACTION_COSTS.challenge=2，
  -- 恢复公式镜像 frontend/src/data.ts 的 spendActionPoints，服务器权威防绕过）
  SELECT current, max, last_recovered_at
    INTO v_ap_current, v_ap_max, v_ap_last
    FROM action_points
   WHERE user_id = v_caller;
  IF v_ap_current IS NULL THEN
    RAISE EXCEPTION 'resolve_pvp: 行动力数据不存在';
  END IF;
  v_ap_elapsed := EXTRACT(EPOCH FROM (now() - v_ap_last));
  v_ap_periods := floor(v_ap_elapsed / 600)::integer;  -- 600 秒 = 10 分钟恢复 1 点
  IF v_ap_current + v_ap_periods < 2 THEN
    RAISE EXCEPTION 'resolve_pvp: 行动点不足';
  END IF;
  v_ap_new_last := v_ap_last + make_interval(secs => v_ap_periods * 600);
  UPDATE action_points
     SET current = LEAST(v_ap_max, v_ap_current + v_ap_periods) - 2,
         last_recovered_at = v_ap_new_last
   WHERE user_id = v_caller;

  -- 2. 复用或新建双方 pending 挑战（同一方向尚无 pending 则补建一条）
  SELECT id INTO v_challenge_id
    FROM challenges
   WHERE challenger_general_id = p_challenger_general_id
     AND target_general_id = p_target_general_id
     AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_challenge_id IS NULL THEN
    INSERT INTO challenges (id, challenger_user_id, target_user_id, challenger_general_id, target_general_id, status)
    VALUES (gen_random_uuid()::text, v_ch_user, v_tg_user, p_challenger_general_id, p_target_general_id, 'pending')
    RETURNING id INTO v_challenge_id;
  END IF;

  -- 3. 战力：armyPower = SUM(count × troop_stats.power)
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0)
    INTO v_ch_army
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_challenger_general_id;
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0)
    INTO v_tg_army
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_target_general_id;

  -- 武器阶（原始 tier），随后用部队最高兵种等级封顶（effectiveWeaponTier）
  SELECT tier INTO v_ch_weapon_tier FROM weapons WHERE id = v_ch_weapon_id;
  SELECT tier INTO v_tg_weapon_tier FROM weapons WHERE id = v_tg_weapon_id;

  -- 部队最高兵种等级：封顶武器有效阶，防止高阶武器挂低阶兵时 PvP 战力高于 PvE。
  -- 镜像 shared/src/combat.ts 的 effectiveWeaponTier（无兵或没武器时有效阶为 0）。
  SELECT COALESCE(MAX(soldier_level), 0) INTO v_ch_max_level
    FROM army_units WHERE general_id = p_challenger_general_id;
  SELECT COALESCE(MAX(soldier_level), 0) INTO v_tg_max_level
    FROM army_units WHERE general_id = p_target_general_id;
  IF v_ch_weapon_tier IS NOT NULL AND v_ch_max_level > 0 THEN
    v_ch_weapon_tier := LEAST(v_ch_weapon_tier, v_ch_max_level);
  ELSE
    v_ch_weapon_tier := NULL;
  END IF;
  IF v_tg_weapon_tier IS NOT NULL AND v_tg_max_level > 0 THEN
    v_tg_weapon_tier := LEAST(v_tg_weapon_tier, v_tg_max_level);
  ELSE
    v_tg_weapon_tier := NULL;
  END IF;

  -- generalMultiplier = 1 + (level-1)*0.05 + (stars-1)*0.10
  v_ch_mult := 1 + (v_ch_level - 1) * 0.05 + (v_ch_stars - 1) * 0.10;
  v_tg_mult := 1 + (v_tg_level - 1) * 0.05 + (v_tg_stars - 1) * 0.10;

  -- generalSidePower = multiplier × armyPower + weaponBonus（每阶 +50，用封顶后的有效阶）
  v_ch_power := v_ch_mult * v_ch_army + COALESCE(v_ch_weapon_tier, 0) * 50;
  v_tg_power := v_tg_mult * v_tg_army + COALESCE(v_tg_weapon_tier, 0) * 50;

  -- 4. 胜率：winProbability（logistic，slope=2.0；含 combat.ts 边界情况）
  IF v_tg_power <= 0 THEN
    v_win_prob := CASE WHEN v_ch_power <= 0 THEN 0.5 ELSE 1 END;
  ELSIF v_ch_power <= 0 THEN
    v_win_prob := 0;
  ELSE
    v_win_prob := 1 / (1 + exp(-2.0 * ln(v_ch_power / v_tg_power)));
  END IF;

  -- 5. 胜负判定：完全均势 → 平局；否则种子随机驱动胜率（rand < winProb）
  IF v_ch_power = v_tg_power THEN
    v_result := 'draw';
    v_winner := NULL;
    v_attacker_won := NULL;
  ELSE
    v_seed := abs(hashtext(p_challenger_general_id || '|' || p_target_general_id || '|' || v_challenge_id)::bigint);
    v_rand := (v_seed % 1000000) / 1000000.0;
    v_attacker_won := v_rand < v_win_prob;
    IF v_attacker_won THEN
      v_result := 'challenger_win';
      v_winner := 'challenger';
    ELSE
      v_result := 'challenger_lose';
      v_winner := 'target';
    END IF;
  END IF;

  -- 6. 战损率：胜方 15%、败方 70%；平局无战损
  IF v_result = 'draw' THEN
    v_ch_rate := 0;
    v_tg_rate := 0;
  ELSIF v_attacker_won THEN
    v_ch_rate := 0.15;
    v_tg_rate := 0.70;
  ELSE
    v_ch_rate := 0.70;
    v_tg_rate := 0.15;
  END IF;

  -- 6b. 战损：对「侧总兵数」向下取整后按各兵堆占比成比例分配（与 combat.ts 一致，
  --     而非逐行向下取整）。allocate_casualties 返回该侧总战损（= floor(总数×战损率)）。
  v_ch_casualties := allocate_casualties(p_challenger_general_id, v_ch_rate);
  v_tg_casualties := allocate_casualties(p_target_general_id, v_tg_rate);

  -- 7. 写 PvP 战斗记录 + 双方战报（每名玩家各一条）
  v_ch_power_int := round(v_ch_power)::integer;
  v_tg_power_int := round(v_tg_power)::integer;
  v_log := jsonb_build_object(
    'challenger', jsonb_build_object('general_id', p_challenger_general_id, 'power', v_ch_power_int, 'casualties', v_ch_casualties),
    'target', jsonb_build_object('general_id', p_target_general_id, 'power', v_tg_power_int, 'casualties', v_tg_casualties),
    'win_prob', round(v_win_prob::numeric, 4),
    'result', v_result
  );

  INSERT INTO pvp_battle_instances (id, challenger_general_id, target_general_id, challenger_user_id, target_user_id, challenger_power, target_power, winner, challenger_casualties, target_casualties, result, log, created_at)
  VALUES (gen_random_uuid()::text, p_challenger_general_id, p_target_general_id, v_ch_user, v_tg_user, v_ch_power_int, v_tg_power_int, v_winner, v_ch_casualties, v_tg_casualties, v_result, v_log, now())
  RETURNING id INTO v_battle_id;

  -- 挑战者战报：victory = 挑战者胜
  INSERT INTO pvp_battle_reports (id, user_id, general_id, battle_instance_id, opponent_general_id, victory, attacker_casualties, defender_casualties, log, created_at)
  VALUES (gen_random_uuid()::text, v_ch_user, p_challenger_general_id, v_battle_id, p_target_general_id, COALESCE(v_attacker_won, false), v_ch_casualties, v_tg_casualties, v_log, now());
  -- 目标战报：victory = 挑战者败
  INSERT INTO pvp_battle_reports (id, user_id, general_id, battle_instance_id, opponent_general_id, victory, attacker_casualties, defender_casualties, log, created_at)
  VALUES (gen_random_uuid()::text, v_tg_user, p_target_general_id, v_battle_id, p_challenger_general_id, COALESCE(NOT v_attacker_won, false), v_ch_casualties, v_tg_casualties, v_log, now());

  -- 8. 更新挑战状态为已结算，并把战力/战损摘要写入 result_summary 供前端展示
  v_summary := jsonb_build_object(
    'challenge_id', v_challenge_id,
    'battle_instance_id', v_battle_id,
    'result', v_result,
    'winner', v_winner,
    'attacker', jsonb_build_object('general_id', p_challenger_general_id, 'power', v_ch_power_int, 'casualties', v_ch_casualties),
    'defender', jsonb_build_object('general_id', p_target_general_id, 'power', v_tg_power_int, 'casualties', v_tg_casualties)
  );
  UPDATE challenges SET status = 'resolved', result = v_result, result_summary = v_summary, resolved_at = now()
   WHERE id = v_challenge_id;

  -- 9. 返回摘要
  RETURN v_summary;

EXCEPTION WHEN OTHERS THEN
  -- 子事务自动回滚后重抛，保证整体原子性
  RAISE;
END;
$$;

-- -------------------------------------------------------------
-- 21. refresh_wildlands：重置攻破超时的野地（服务器权威刷新）
-- -------------------------------------------------------------
-- SECURITY DEFINER 以函数所有者身份执行，绕开共享世界只读的 RLS（wildlands RLS 禁止客户端写）。
-- 把攻破时间超过 5 分钟的野地 defeated_at 清空，使其在 fetchWorld 中重新出现。
-- 刷新窗口 5 分钟与 shared 层 WILDLAND_REFRESH_MS=300000ms 保持一致。
CREATE OR REPLACE FUNCTION refresh_wildlands(p_world_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE wildlands
  SET defeated_at = NULL
  WHERE world_id = p_world_id
    AND defeated_at IS NOT NULL
    AND defeated_at < now() - interval '5 minutes';
END;
$$;

-- =============================================================
-- 22. resolve_siege：攻城服务器权威战斗结算（SECURITY DEFINER）
-- =============================================================
-- SECURITY DEFINER 以函数所有者身份执行，绕开 RLS，从而可同时原子更新
-- army_units / cities / resources / action_points / sieges / pvp 记录。
-- 结算公式镜像 resolve_pvp（进而镜像 shared/src/combat.ts）：
--   generalMultiplier(level, stars) = 1 + (level-1)*0.05 + (stars-1)*0.10
--   armyPower = SUM(count × troop_stats.power)
--   weaponBonus = cappedWeaponTier × 50（有效阶由部队最高兵种等级封顶）
--   generalSidePower = generalMultiplier × armyPower + weaponBonus
--   winProbability = 1/(1+exp(-2.0*ln(attacker/defender)))
--   胜方轻损 15%、败方重损 70%（战损 = floor(侧总兵数×rate)，由 allocate_casualties 按行分配）
-- 与 resolve_pvp 的差异：
--   1) 城池攻防无平局：均势时胜率恰为 0.5，由种子随机定胜负，sieges.result 仅两种；
--   2) 守方武将非入参：取城池主人麾下最早创建的一名武将作为守将（确定性默认）；
--   3) 攻击方胜出后：转移 cities.owner_user_id + 掠夺守方 resources（gold/food）——
--      掠夺为「转移」而非铸币：从守方扣除实际可掠量，等额加到攻击方，防经济通膨。
-- 胜负判定种子：abs(hashtext(攻击方武将 id | 城池 id | 攻城 id))，模拟 combat.ts mulberry32。
-- 防刷：同城池 60 秒冷却 + 扣除 2 行动点（镜像 resolve_pvp）。
-- 事务原子性：plpgsql 内不允许显式 COMMIT/ROLLBACK，EXCEPTION 子句为函数主体建立
-- 子事务，异常时自动回滚并重抛，保证整体原子性。
CREATE OR REPLACE FUNCTION resolve_siege(
  p_attacker_general_id text,
  p_target_city_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  -- 攻击方武将
  v_att_user uuid;
  v_att_level integer;
  v_att_stars integer;
  v_att_weapon_id text;
  -- 目标城池
  v_city_owner uuid;
  -- 守城武将（城池主人麾下最早创建的一名）
  v_def_general_id text;
  v_def_level integer;
  v_def_stars integer;
  v_def_weapon_id text;
  -- 城池主人免战期（新手保护）
  v_owner_protection timestamptz;
  -- 战力计算
  v_att_army numeric;
  v_def_army numeric;
  v_att_weapon_tier integer;
  v_def_weapon_tier integer;
  v_att_max_level integer;
  v_def_max_level integer;
  v_att_mult numeric;
  v_def_mult numeric;
  v_att_power numeric;
  v_def_power numeric;
  v_win_prob numeric;
  v_seed bigint;
  v_rand numeric;
  v_attacker_won boolean;
  v_result text;
  v_att_rate numeric;
  v_def_rate numeric;
  -- 防刷：同城池冷却 + 行动点门槛
  v_last_siege_at timestamptz;
  v_ap_current integer;
  v_ap_max integer;
  v_ap_last timestamptz;
  v_ap_elapsed numeric;
  v_ap_periods integer;
  v_ap_new_last timestamptz;
  -- 战损统计（总额，由 allocate_casualties 计算）
  v_att_casualties integer := 0;
  v_def_casualties integer := 0;
  -- 掠夺量（依守军战力换算）
  v_plunder integer := 0;
  -- 守方当前资源与实际掠夺量（转移而非铸币，守方不足时掠其实际所有）
  v_def_food integer := 0;
  v_def_gold integer := 0;
  v_plundered_food integer := 0;
  v_plundered_gold integer := 0;
  -- 攻城记录
  v_siege_id text;
  -- 战斗记录
  v_battle_id text;
  v_log jsonb;
  v_summary jsonb;
  v_att_power_int integer;
  v_def_power_int integer;
BEGIN
  -- 1. 校验：登录态 + 攻击方武将存在且归属本人 + 城池存在且有主 + 非自己城池 + 守城武将存在
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'resolve_siege: 未登录';
  END IF;

  SELECT user_id, level, stars, weapon_id
    INTO v_att_user, v_att_level, v_att_stars, v_att_weapon_id
    FROM generals
   WHERE id = p_attacker_general_id;
  IF v_att_user IS NULL THEN
    RAISE EXCEPTION 'resolve_siege: 攻击方武将不存在 %', p_attacker_general_id;
  END IF;
  IF v_att_user <> v_caller THEN
    RAISE EXCEPTION 'resolve_siege: 无权以他人武将发起攻城';
  END IF;

  SELECT owner_user_id
    INTO v_city_owner
    FROM cities
   WHERE id = p_target_city_id;
  IF v_city_owner IS NULL THEN
    RAISE EXCEPTION 'resolve_siege: 目标城池不存在或已无主 %', p_target_city_id;
  END IF;
  IF v_city_owner = v_caller THEN
    RAISE EXCEPTION 'resolve_siege: 不能进攻自己的城池';
  END IF;

  -- 守城武将：城池主人麾下最早创建的一名（攻城不指定守将，取确定性默认）
  SELECT id, level, stars, weapon_id
    INTO v_def_general_id, v_def_level, v_def_stars, v_def_weapon_id
    FROM generals
   WHERE user_id = v_city_owner
   ORDER BY created_at, id
   LIMIT 1;
  IF v_def_general_id IS NULL THEN
    RAISE EXCEPTION 'resolve_siege: 该城池主人没有武将，无法防守';
  END IF;

  -- 1a. 免战期校验：城池主人处于新手保护期则拒绝攻城（先于冷却/扣行动点，避免白费行动点）
  SELECT peace_protection_until INTO v_owner_protection
    FROM progression
   WHERE user_id = v_city_owner;
  IF v_owner_protection IS NOT NULL AND v_owner_protection > now() THEN
    RAISE EXCEPTION '对方处于免战期，暂时无法攻城';
  END IF;

  -- 1b. 防刷：对同一目标城池的攻城设有冷却（60 秒内不可重复），并扣除行动点
  SELECT created_at INTO v_last_siege_at
    FROM sieges
   WHERE attacker_user_id = v_caller
     AND target_city_id = p_target_city_id
     AND status IN ('pending', 'resolved')
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_last_siege_at IS NOT NULL
     AND now() - v_last_siege_at < interval '60 seconds' THEN
    RAISE EXCEPTION 'resolve_siege: 冷却中，60 秒内不能重复进攻同一城池';
  END IF;

  -- 行动点门槛与扣除（每 10 分钟恢复 1 点；消耗=ACTION_COSTS.challenge=2，
  -- 恢复公式镜像 resolve_pvp 的 spendActionPoints，服务器权威防绕过）
  SELECT current, max, last_recovered_at
    INTO v_ap_current, v_ap_max, v_ap_last
    FROM action_points
   WHERE user_id = v_caller;
  IF v_ap_current IS NULL THEN
    RAISE EXCEPTION 'resolve_siege: 行动力数据不存在';
  END IF;
  v_ap_elapsed := EXTRACT(EPOCH FROM (now() - v_ap_last));
  v_ap_periods := floor(v_ap_elapsed / 600)::integer;  -- 600 秒 = 10 分钟恢复 1 点
  IF v_ap_current + v_ap_periods < 2 THEN
    RAISE EXCEPTION 'resolve_siege: 行动点不足';
  END IF;
  v_ap_new_last := v_ap_last + make_interval(secs => v_ap_periods * 600);
  UPDATE action_points
     SET current = LEAST(v_ap_max, v_ap_current + v_ap_periods) - 2,
         last_recovered_at = v_ap_new_last
   WHERE user_id = v_caller;

  -- 2. 复用或新建攻击方对目标城池的 pending 攻城记录（同一方向尚无 pending 则补建一条）
  SELECT id INTO v_siege_id
    FROM sieges
   WHERE attacker_user_id = v_caller
     AND target_city_id = p_target_city_id
     AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_siege_id IS NULL THEN
    INSERT INTO sieges (id, attacker_user_id, target_city_id, status)
    VALUES (gen_random_uuid()::text, v_caller, p_target_city_id, 'pending')
    RETURNING id INTO v_siege_id;
  END IF;

  -- 3. 战力：armyPower = SUM(count × troop_stats.power)
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0)
    INTO v_att_army
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_attacker_general_id;
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0)
    INTO v_def_army
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = v_def_general_id;

  -- 武器阶（原始 tier），随后用部队最高兵种等级封顶（effectiveWeaponTier）
  SELECT tier INTO v_att_weapon_tier FROM weapons WHERE id = v_att_weapon_id;
  SELECT tier INTO v_def_weapon_tier FROM weapons WHERE id = v_def_weapon_id;

  -- 部队最高兵种等级：封顶武器有效阶，防止高阶武器挂低阶兵时攻城战力高于 PvE。
  SELECT COALESCE(MAX(soldier_level), 0) INTO v_att_max_level
    FROM army_units WHERE general_id = p_attacker_general_id;
  SELECT COALESCE(MAX(soldier_level), 0) INTO v_def_max_level
    FROM army_units WHERE general_id = v_def_general_id;
  IF v_att_weapon_tier IS NOT NULL AND v_att_max_level > 0 THEN
    v_att_weapon_tier := LEAST(v_att_weapon_tier, v_att_max_level);
  ELSE
    v_att_weapon_tier := NULL;
  END IF;
  IF v_def_weapon_tier IS NOT NULL AND v_def_max_level > 0 THEN
    v_def_weapon_tier := LEAST(v_def_weapon_tier, v_def_max_level);
  ELSE
    v_def_weapon_tier := NULL;
  END IF;

  -- generalMultiplier = 1 + (level-1)*0.05 + (stars-1)*0.10
  v_att_mult := 1 + (v_att_level - 1) * 0.05 + (v_att_stars - 1) * 0.10;
  v_def_mult := 1 + (v_def_level - 1) * 0.05 + (v_def_stars - 1) * 0.10;

  -- generalSidePower = multiplier × armyPower + weaponBonus（每阶 +50，用封顶后的有效阶）
  v_att_power := v_att_mult * v_att_army + COALESCE(v_att_weapon_tier, 0) * 50;
  v_def_power := v_def_mult * v_def_army + COALESCE(v_def_weapon_tier, 0) * 50;

  -- 4. 胜率：winProbability（logistic，slope=2.0；含 combat.ts 边界情况）
  IF v_def_power <= 0 THEN
    v_win_prob := CASE WHEN v_att_power <= 0 THEN 0.5 ELSE 1 END;
  ELSIF v_att_power <= 0 THEN
    v_win_prob := 0;
  ELSE
    v_win_prob := 1 / (1 + exp(-2.0 * ln(v_att_power / v_def_power)));
  END IF;

  -- 5. 胜负判定：城池攻防无平局——均势时胜率恰为 0.5，由种子随机定胜负
  v_seed := abs(hashtext(p_attacker_general_id || '|' || p_target_city_id || '|' || v_siege_id)::bigint);
  v_rand := (v_seed % 1000000) / 1000000.0;
  v_attacker_won := v_rand < v_win_prob;
  IF v_attacker_won THEN
    v_result := 'attacker_win';
  ELSE
    v_result := 'attacker_lose';
  END IF;

  -- 6. 战损率：胜方 15%、败方 70%
  IF v_attacker_won THEN
    v_att_rate := 0.15;
    v_def_rate := 0.70;
  ELSE
    v_att_rate := 0.70;
    v_def_rate := 0.15;
  END IF;

  -- 6b. 战损：对「侧总兵数」向下取整后按各兵堆占比成比例分配（镜像 allocate_casualties）
  v_att_casualties := allocate_casualties(p_attacker_general_id, v_att_rate);
  v_def_casualties := allocate_casualties(v_def_general_id, v_def_rate);

  -- 7. 攻击方获胜：转移城池所有权 + 掠夺资源（镜像 wildlandDrop 思路：守军战力/10，至少 1）
  --    掠夺为「转移」而非铸币：从守方 resources 扣除实际可掠量，再等额加到攻击方，
  --    防止凭空铸币造成经济通膨；守方存量不足则掠其实际所有（保底 0）。
  IF v_attacker_won THEN
    UPDATE cities SET owner_user_id = v_caller WHERE id = p_target_city_id;
    v_plunder := GREATEST(1, round(v_def_power / 10)::integer);
    -- 读取守方当前资源（无行视为 0）
    SELECT COALESCE(food, 0), COALESCE(gold, 0)
      INTO v_def_food, v_def_gold
      FROM resources
     WHERE user_id = v_city_owner;
    -- 实际掠夺量 = 计划量 与 守方存量 的较小值（不足则掠其实际所有）
    v_plundered_food := LEAST(v_plunder, v_def_food);
    v_plundered_gold := LEAST(v_plunder, v_def_gold);
    -- 扣守方（存量 > 0 才更新，避免对无资源行做无意义写）
    IF v_def_food > 0 OR v_def_gold > 0 THEN
      UPDATE resources
         SET food = GREATEST(0, food - v_plundered_food),
             gold = GREATEST(0, gold - v_plundered_gold)
       WHERE user_id = v_city_owner;
    END IF;
    -- 等额加到攻击方（实际掠夺 > 0 才写）
    IF v_plundered_food > 0 OR v_plundered_gold > 0 THEN
      INSERT INTO resources (user_id, food, iron, rare, gold)
      VALUES (v_caller, v_plundered_food, 0, 0, v_plundered_gold)
      ON CONFLICT (user_id) DO UPDATE
        SET food = resources.food + EXCLUDED.food,
            gold = resources.gold + EXCLUDED.gold;
    END IF;
  END IF;

  -- 8. 写 PvP 战斗记录 + 双方战报（每名玩家各一条；攻防即 challenger/target）
  v_att_power_int := round(v_att_power)::integer;
  v_def_power_int := round(v_def_power)::integer;
  v_log := jsonb_build_object(
    'attacker', jsonb_build_object('general_id', p_attacker_general_id, 'power', v_att_power_int, 'casualties', v_att_casualties),
    'defender', jsonb_build_object('general_id', v_def_general_id, 'power', v_def_power_int, 'casualties', v_def_casualties),
    'win_prob', round(v_win_prob::numeric, 4),
    'result', v_result
  );

  INSERT INTO pvp_battle_instances (id, challenger_general_id, target_general_id, challenger_user_id, target_user_id, challenger_power, target_power, winner, challenger_casualties, target_casualties, result, log, created_at)
  VALUES (gen_random_uuid()::text, p_attacker_general_id, v_def_general_id, v_att_user, v_city_owner, v_att_power_int, v_def_power_int, CASE WHEN v_attacker_won THEN 'challenger' ELSE 'target' END, v_att_casualties, v_def_casualties, CASE WHEN v_attacker_won THEN 'challenger_win' ELSE 'challenger_lose' END, v_log, now())
  RETURNING id INTO v_battle_id;

  -- 攻击方战报：victory = 攻击方胜
  INSERT INTO pvp_battle_reports (id, user_id, general_id, battle_instance_id, opponent_general_id, victory, attacker_casualties, defender_casualties, log, created_at)
  VALUES (gen_random_uuid()::text, v_att_user, p_attacker_general_id, v_battle_id, v_def_general_id, v_attacker_won, v_att_casualties, v_def_casualties, v_log, now());
  -- 守方战报：victory = 攻击方败
  INSERT INTO pvp_battle_reports (id, user_id, general_id, battle_instance_id, opponent_general_id, victory, attacker_casualties, defender_casualties, log, created_at)
  VALUES (gen_random_uuid()::text, v_city_owner, v_def_general_id, v_battle_id, p_attacker_general_id, NOT v_attacker_won, v_att_casualties, v_def_casualties, v_log, now());

  -- 9. 更新攻城记录为已结算，写胜负摘要
  v_summary := jsonb_build_object(
    'siege_id', v_siege_id,
    'battle_instance_id', v_battle_id,
    'result', v_result,
    'city_captured', v_attacker_won,
    'plunder_food', v_plundered_food,
    'plunder_gold', v_plundered_gold,
    'attacker', jsonb_build_object('general_id', p_attacker_general_id, 'power', v_att_power_int, 'casualties', v_att_casualties),
    'defender', jsonb_build_object('general_id', v_def_general_id, 'power', v_def_power_int, 'casualties', v_def_casualties)
  );
  UPDATE sieges SET status = 'resolved', result = v_result, resolved_at = now()
   WHERE id = v_siege_id;

  -- 10. 返回摘要
  RETURN v_summary;

EXCEPTION WHEN OTHERS THEN
  -- 子事务自动回滚后重抛，保证整体原子性
  RAISE;
END;
$$;

