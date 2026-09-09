-- =============================================================
-- MyGame 无服务器重构 —— Supabase 数据模型 + RLS 策略
-- =============================================================
-- 执行方式：
--   1. 登录 Supabase 控制台，进入目标项目的 Dashboard
--   2. 打开左侧 SQL Editor（SQL 编辑器）
--   3. 新建查询，将本文件全部内容粘贴进去
--   4. 点击 Run（运行），一次执行全部 DDL 与 RLS 策略
--   5. 若后续改动，直接重新粘贴整份文件执行即可（本文件为全新建库
--      方式，不含 IF NOT EXISTS，请确保目标库为空库或按需局部执行）
-- 适用：Supabase Postgres 15+（anon key 直连 + RLS 防串读/串改）
-- =============================================================

-- =============================================================
-- 设计决策说明
-- =============================================================
-- 1. 身份模型：不再建 users 表。
--    原 users 存储 username / password_hash，现由 Supabase Auth
--    （auth.users）统一管理登录态。所有玩家数据表改用
--    user_id uuid REFERENCES auth.users(id) 关联身份。
--    展示名由 profiles 表承载（user_id 主键、username、created_at）。
--
-- 2. sessions 表删除：Supabase Auth 自管会话（access/refresh token），
--    无需自建 token 会话表。
--
-- 3. 外键关联全部指向 auth.users(id)，字段类型由 TEXT 改为 uuid。
--    其余业务表主键仍用 TEXT（前端生成，如 crypto.randomUUID()）。
--
-- 4. 所有权与 RLS：
--    - 玩家私有表（profiles/resources/weapons/generals/progression/
--      army_units/action_points/marches/battle_instances/battle_reports/
--      cities）均带 user_id（或 owner_user_id）列，策略以
--      auth.uid() = 该列为准，只读/写自己的行。
--    - army_units 原仅经 generals 间接归属玩家，为满足按 owner 隔离，
--      新增冗余 user_id 列（与所属武将一致），避免跨表子查询。
--    - cities 用 owner_user_id（可被置空表示无主城池），策略
--      以 owner_user_id = auth.uid() 为准；INSERT 时必须指定本人。
--    - battle_instances 的归属列是 attacker_user_id（战斗发起方）。
--    - worlds / world_tiles 为共享世界数据：任意登录用户可 SELECT，
--      禁止客户端写。
--    - wildlands 为共享野地：登录用户可 SELECT；攻打后回写
--      defeated_at / drop 仅限「触发该战斗的玩家」——通过
--      battle_instances（defender_wildland_id 对应 + attacker_user_id
--      为本用户）判定。
--
-- 5. 保留全部原约束：
--    - army_units UNIQUE(general_id, soldier_level)
--    - cities UNIQUE(world_id, x, y)
--    - marches 部分唯一索引（general_id）WHERE status='active'
--    - weapons.general_id -> generals(id) 循环外键（后置 ALTER 补上）
--    - world_tiles.terrain 枚举、marches.status 枚举、battle_instances.winner 枚举
--    - wildlands 的 drop / defeated_at 列已并入建表语句（原为迁移补丁）
--    - generals.stars 列已并入建表语句（原为迁移补丁）
-- =============================================================

-- -------------------------------------------------------------
-- 1. profiles：玩家展示资料（原 users 的展示部分）
-- -------------------------------------------------------------
CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- 2. worlds：大地图（共享世界）
-- -------------------------------------------------------------
CREATE TABLE worlds (
  id text PRIMARY KEY,
  name text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  seed integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- 3. world_tiles：大地图格子（共享世界）
-- -------------------------------------------------------------
CREATE TABLE world_tiles (
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  x integer NOT NULL,
  y integer NOT NULL,
  terrain text NOT NULL CHECK (terrain IN ('g','f','m','w')),
  PRIMARY KEY (world_id, x, y)
);

-- -------------------------------------------------------------
-- 4. weapons：武器（先建，generals 引用其 id）
--    general_id 外键到 generals 为循环引用，故在 generals 建完后
--    用 ALTER 补上（见第 5 步末尾）。
-- -------------------------------------------------------------
CREATE TABLE weapons (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  tier integer NOT NULL,
  general_id text
);

-- -------------------------------------------------------------
-- 5. generals：武将
-- -------------------------------------------------------------
CREATE TABLE generals (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  level integer NOT NULL,
  stars integer NOT NULL DEFAULT 1,
  weapon_id text REFERENCES weapons(id),
  world_id text REFERENCES worlds(id),
  x integer NOT NULL DEFAULT 0,
  y integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 补齐 weapons -> generals 的循环外键（原迁移补丁）
ALTER TABLE weapons
  ADD CONSTRAINT weapons_general_id_fkey FOREIGN KEY (general_id)
  REFERENCES generals(id) ON DELETE SET NULL;

-- -------------------------------------------------------------
-- 6. cities：城池（玩家拥有，owner_user_id 可空表示无主）
-- -------------------------------------------------------------
CREATE TABLE cities (
  id text PRIMARY KEY,
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  x integer NOT NULL,
  y integer NOT NULL,
  name text NOT NULL,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, x, y)
);

-- -------------------------------------------------------------
-- 7. wildlands：野地（共享，drop/defeated_at 已并入建表）
-- -------------------------------------------------------------
CREATE TABLE wildlands (
  id text PRIMARY KEY,
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  x integer NOT NULL,
  y integer NOT NULL,
  name text NOT NULL,
  strength integer NOT NULL,
  drop integer NOT NULL DEFAULT 0,
  defeated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- 8. progression：养成进度（每玩家一行）
-- -------------------------------------------------------------
CREATE TABLE progression (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  troop_max_unlocked integer NOT NULL DEFAULT 3
);

-- -------------------------------------------------------------
-- 9. resources：玩家资源（每玩家一行）
-- -------------------------------------------------------------
CREATE TABLE resources (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  food integer NOT NULL,
  iron integer NOT NULL,
  rare integer NOT NULL,
  gold integer NOT NULL
);

-- -------------------------------------------------------------
-- 10. action_points：行动力（每玩家一行）
-- -------------------------------------------------------------
CREATE TABLE action_points (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  current integer NOT NULL,
  max integer NOT NULL,
  last_recovered_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- 11. army_units：部队（按兵种分档；新增冗余 user_id 以按 owner 隔离）
-- -------------------------------------------------------------
CREATE TABLE army_units (
  id text PRIMARY KEY,
  general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  soldier_type text NOT NULL,
  soldier_level integer NOT NULL,
  count integer NOT NULL,
  UNIQUE (general_id, soldier_level)
);

-- -------------------------------------------------------------
-- 12. marches：行军
-- -------------------------------------------------------------
CREATE TABLE marches (
  id text PRIMARY KEY,
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  origin_x integer NOT NULL,
  origin_y integer NOT NULL,
  target_x integer NOT NULL,
  target_y integer NOT NULL,
  departed_at timestamptz NOT NULL,
  arrives_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','arrived','cancelled')),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 同一武将同时只允许一条 active 行军（原迁移补丁）
CREATE UNIQUE INDEX marches_general_id_active_unique
  ON marches (general_id)
  WHERE status = 'active';

-- -------------------------------------------------------------
-- 13. battle_instances：战斗实例（归属方为 attacker_user_id）
-- -------------------------------------------------------------
CREATE TABLE battle_instances (
  id text PRIMARY KEY,
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  attacker_general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  attacker_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  defender_wildland_id text NOT NULL REFERENCES wildlands(id) ON DELETE CASCADE,
  attacker_power integer NOT NULL,
  defender_power integer NOT NULL,
  winner text NOT NULL CHECK (winner IN ('attacker','defender')),
  attacker_casualties integer NOT NULL,
  defender_casualties integer NOT NULL,
  dropped_rare integer NOT NULL DEFAULT 0,
  skill_used boolean NOT NULL DEFAULT false,
  log jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- 14. battle_reports：战斗报告
-- -------------------------------------------------------------
CREATE TABLE battle_reports (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  general_id text NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
  battle_instance_id text NOT NULL REFERENCES battle_instances(id) ON DELETE CASCADE,
  wildland_id text NOT NULL REFERENCES wildlands(id) ON DELETE CASCADE,
  wildland_name text NOT NULL,
  victory boolean NOT NULL,
  attacker_casualties integer NOT NULL,
  defender_casualties integer NOT NULL,
  dropped_rare integer NOT NULL DEFAULT 0,
  log jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 启用行级安全（RLS）
-- =============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE worlds ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_tiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE weapons ENABLE ROW LEVEL SECURITY;
ALTER TABLE generals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE wildlands ENABLE ROW LEVEL SECURITY;
ALTER TABLE progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE army_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE marches ENABLE ROW LEVEL SECURITY;
ALTER TABLE battle_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE battle_reports ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- RLS 策略
-- =============================================================

-- ---------------- profiles（仅本人） ----------------
CREATE POLICY profiles_select ON profiles
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY profiles_insert ON profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY profiles_update ON profiles
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY profiles_delete ON profiles
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- worlds / world_tiles（登录可读，禁写） ----------------
CREATE POLICY worlds_select ON worlds
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY world_tiles_select ON world_tiles
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ---------------- weapons（仅本人） ----------------
CREATE POLICY weapons_select ON weapons
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY weapons_insert ON weapons
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY weapons_update ON weapons
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY weapons_delete ON weapons
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- generals（共享世界：登录用户可见所有武将，写操作仅本人） ----------------
CREATE POLICY generals_select ON generals
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY generals_insert ON generals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY generals_update ON generals
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY generals_delete ON generals
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- cities（共享世界：登录用户可见所有城池，写操作仅本人） ----------------
CREATE POLICY cities_select ON cities
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY cities_insert ON cities
  FOR INSERT WITH CHECK (auth.uid() = owner_user_id);
CREATE POLICY cities_update ON cities
  FOR UPDATE USING (auth.uid() = owner_user_id) WITH CHECK (auth.uid() = owner_user_id);
CREATE POLICY cities_delete ON cities
  FOR DELETE USING (auth.uid() = owner_user_id);

-- ---------------- wildlands（登录可读；攻打者回写战斗结果） ----------------
CREATE POLICY wildlands_select ON wildlands
  FOR SELECT USING (auth.uid() IS NOT NULL);
-- 攻打者回写仅允许「真实打赢」：匹配的 battle_instances 必须是该攻击者发起且
-- winner='attacker'，且目标野地尚未被攻破（defeated_at IS NULL 防止重复改写）。
-- 防御纵深：即便用户能自行 INSERT 伪造 battle_instances，也至少要求伪造行声明
-- 攻击者胜，并与 UPDATE USING 的 defeated_at 守卫共同兜底，避免任意改任意野地。
CREATE POLICY wildlands_update_attacker ON wildlands
  FOR UPDATE USING (
    defeated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM battle_instances b
      WHERE b.defender_wildland_id = id
        AND b.attacker_user_id = auth.uid()
        AND b.winner = 'attacker'
    )
  );

-- 攻打者 RLS UPDATE 策略只决定"能改哪些行"，但野地为共享数据，不能用 WITH CHECK
-- 做按列收窄：WITH CHECK 只检查 NEW 行，无法与 OLD 行对比，攻打者凭自身 battle_instances
-- 匹配即可把 name/strength/坐标等共享列一并改掉。故用 BEFORE UPDATE 触发器做列级守卫：
-- 仅允许 drop / defeated_at 发生变化，其余列必须保持不变。
CREATE OR REPLACE FUNCTION wildlands_attacker_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.world_id IS DISTINCT FROM OLD.world_id
     OR NEW.x IS DISTINCT FROM OLD.x
     OR NEW.y IS DISTINCT FROM OLD.y
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.strength IS DISTINCT FROM OLD.strength
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'wildlands: 攻打者仅允许更新 drop / defeated_at 列';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wildlands_attacker_update_guard
  BEFORE UPDATE ON wildlands
  FOR EACH ROW
  EXECUTE FUNCTION wildlands_attacker_update_guard();

-- ---------------- progression（仅本人） ----------------
CREATE POLICY progression_select ON progression
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY progression_insert ON progression
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY progression_update ON progression
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY progression_delete ON progression
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- resources（仅本人） ----------------
CREATE POLICY resources_select ON resources
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY resources_insert ON resources
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY resources_update ON resources
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY resources_delete ON resources
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- action_points（仅本人） ----------------
CREATE POLICY action_points_select ON action_points
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY action_points_insert ON action_points
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY action_points_update ON action_points
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY action_points_delete ON action_points
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- army_units（仅本人；general_id 须归本人） ----------------
CREATE POLICY army_units_select ON army_units
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY army_units_insert ON army_units
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM generals g WHERE g.id = general_id AND g.user_id = auth.uid()
    )
  );
CREATE POLICY army_units_update ON army_units
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY army_units_delete ON army_units
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- marches（仅本人；general_id 须归本人） ----------------
CREATE POLICY marches_select ON marches
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY marches_insert ON marches
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM generals g WHERE g.id = general_id AND g.user_id = auth.uid()
    )
  );
CREATE POLICY marches_update ON marches
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY marches_delete ON marches
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------- battle_instances（归属方为攻击者） ----------------
CREATE POLICY battle_instances_select ON battle_instances
  FOR SELECT USING (auth.uid() = attacker_user_id);
CREATE POLICY battle_instances_insert ON battle_instances
  FOR INSERT WITH CHECK (auth.uid() = attacker_user_id);
CREATE POLICY battle_instances_update ON battle_instances
  FOR UPDATE USING (auth.uid() = attacker_user_id) WITH CHECK (auth.uid() = attacker_user_id);
CREATE POLICY battle_instances_delete ON battle_instances
  FOR DELETE USING (auth.uid() = attacker_user_id);

-- ---------------- battle_reports（仅本人） ----------------
CREATE POLICY battle_reports_select ON battle_reports
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY battle_reports_insert ON battle_reports
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY battle_reports_update ON battle_reports
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY battle_reports_delete ON battle_reports
  FOR DELETE USING (auth.uid() = user_id);

-- =============================================================
-- 15. 新账号初始化：注册后自动播种初始游戏状态
-- =============================================================
-- 背景：auth.signUp 只创建 auth 账号，不会建立任何游戏数据。若新玩家
-- 没有初始武将/资源/行动点/养成进度/世界成员资格，登录后 fetchWorld 会
-- 报「世界尚未初始化」或空世界 + 无武将 → 无法招募/出征/打野。
--
-- 方案：采用「服务端 DB 触发器」（SECURITY DEFINER）在 auth.users 插入
-- 后立即建档。这是 schema，不是后端代码，天然契合 serverless 架构：
--   - 无客户端竞态：无需前端首次登录时额外调 ensureNewUser，不会因并发
--     登录重复播种；
--   - 触发器以函数所有者（运行本 SQL 的 postgres/supabase_admin，为表
--     所有者）执行，绕过 RLS，插入不受各表 INSERT 策略限制。
-- 约束：依赖 Supabase Auth（auth.users）与内置 gen_random_uuid()（PG13+）。
-- 本地裸 Postgres 无 auth 库时该触发器无法创建——属预期假设，生产在
-- Supabase 控制台 SQL Editor 执行本文件。
--
-- 播种内容（与 shared 常量一致：AP_MAX=5、INITIAL_TROOP_UNLOCK=3）：
--   - worlds：无世界则新建默认世界「荆州」20×14，否则复用最早的世界；
--   - weapons：木矛（tier 1，含 1 名初始武将）；
--   - generals：1 级 1 星「队长」，装备木矛，落位主城旁；
--   - army_units：100 名乡勇（soldier_level 1）；
--   - cities：一座主城（owner_user_id = 新用户），与武将相邻；
--   - resources：初始粮草/铁材/金币（稀有材料从打野产出，初始为 0）；
--   - action_points：current = max = 5；
--   - progression：troop_max_unlocked = 3。
-- 世界内容播种：为世界生成地形网格与野地（幂等：已有地形则跳过）。
-- world_tiles/wildlands 为共享只读（RLS 禁止客户端写），须由服务端（SECURITY DEFINER）播种。
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

CREATE OR REPLACE FUNCTION seed_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_world_id text;
  v_weapon_id text;
  v_general_id text;
  v_city_id text;
  v_cx integer;
  v_cy integer;
  v_hash integer;
  v_world_w integer;
  v_world_h integer;
  v_base integer;
  v_idx integer;
  v_off integer;
  v_occupied boolean;
BEGIN
  -- 1. 确定世界：复用最早存在的世界，否则新建默认世界
  SELECT id INTO v_world_id FROM worlds ORDER BY created_at, id LIMIT 1;
  IF v_world_id IS NULL THEN
    v_world_id := 'w-default';
    INSERT INTO worlds (id, name, width, height, seed, created_at)
    VALUES (v_world_id, '荆州', 20, 14, 1, now());
  END IF;

  -- 播种世界内容（地形网格 + 野地）：幂等，已有地形则跳过
  PERFORM seed_world_content(v_world_id);

  -- 2. 主城：在共享世界里为每个用户挑一个不重复的格子落位，归属新用户。
  --    共享世界对所有人可见，若全落固定 (3,3) 则第二个用户撞
  --    cities UNIQUE(world_id, x, y) 会异常上抛导致 auth.users 建档失败。
  --    方案：以 NEW.id 的哈希确定起始格，再逐格扫描首个空闲格
  --    （空闲 = 该格无城池，且其右侧相邻格无城池/武将，保证武将能并排落位）。
  SELECT width, height INTO v_world_w, v_world_h FROM worlds WHERE id = v_world_id;
  -- NEW.id 是 uuid，hashtext 需 text；uuid→text 是赋值级转换，函数实参须显式 ::text，
  -- 否则运行时抛 "function hashtext(uuid) does not exist" 导致注册回滚。
  v_hash := abs(hashtext(NEW.id::text));
  v_base := ((v_hash / v_world_w) % v_world_h) * v_world_w + (v_hash % v_world_w); -- 0..w*h-1
  FOR v_off IN 0..(v_world_w * v_world_h - 1) LOOP
    v_idx := (v_base + v_off) % (v_world_w * v_world_h);
    v_cx := (v_idx % v_world_w) + 1;
    v_cy := (v_idx / v_world_w) + 1;
    v_occupied := EXISTS (
        SELECT 1 FROM cities c
        WHERE c.world_id = v_world_id AND c.x = v_cx AND c.y = v_cy
      );
    IF NOT v_occupied THEN
      IF v_cx >= v_world_w THEN
        -- 城市落在最右列，右侧无格放武将，跳过该格
        v_occupied := TRUE;
      ELSE
        -- 武将落位 (cx+1, cy)，需右侧格也无城池/武将
        v_occupied := EXISTS (
            SELECT 1 FROM cities c
            WHERE c.world_id = v_world_id AND c.x = v_cx + 1 AND c.y = v_cy
          ) OR EXISTS (
            SELECT 1 FROM generals g
            WHERE g.world_id = v_world_id AND g.x = v_cx + 1 AND g.y = v_cy
          );
      END IF;
    END IF;
    IF NOT v_occupied THEN
      EXIT;
    END IF;
  END LOOP;

  -- 3. 主城写入（v_cx, v_cy 已确定）
  v_city_id := gen_random_uuid()::text;
  INSERT INTO cities (id, world_id, x, y, name, owner_user_id, created_at)
  VALUES (v_city_id, v_world_id, v_cx, v_cy, '主营', NEW.id, now());

  -- 4. 武器：木矛（tier 1），general_id 暂空，武将建好后再回填
  v_weapon_id := gen_random_uuid()::text;
  INSERT INTO weapons (id, user_id, name, tier, general_id)
  VALUES (v_weapon_id, NEW.id, '木矛', 1, NULL);

  -- 5. 武将：1 级 1 星「队长」，装备木矛，紧邻主城右侧 (v_cx+1, v_cy) 落位
  v_general_id := gen_random_uuid()::text;
  INSERT INTO generals (id, user_id, name, level, stars, weapon_id, world_id, x, y, created_at)
  VALUES (v_general_id, NEW.id, '队长', 1, 1, v_weapon_id, v_world_id, v_cx + 1, v_cy, now());

  -- 6. 回填武器归属武将（补 weapons -> generals 循环外键）
  UPDATE weapons SET general_id = v_general_id WHERE id = v_weapon_id;

  -- 7. 初始部队：100 名乡勇
  INSERT INTO army_units (id, general_id, user_id, soldier_type, soldier_level, count)
  VALUES (gen_random_uuid()::text, v_general_id, NEW.id, '乡勇', 1, 100);

  -- 8. 资源 / 行动点 / 养成进度
  INSERT INTO resources (user_id, food, iron, rare, gold)
  VALUES (NEW.id, 2000, 1000, 0, 500);
  INSERT INTO action_points (user_id, current, max, last_recovered_at)
  VALUES (NEW.id, 5, 5, now());
  INSERT INTO progression (user_id, troop_max_unlocked)
  VALUES (NEW.id, 3);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 种子失败不阻断注册：记录告警并放行，避免 auth.users 插入被回滚。
  RAISE WARNING 'seed_new_user 失败 user=% msg=%', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_seed_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION seed_new_user();

-- =============================================================
-- 16. 军团（社交层）：创建/加入/退出，无 PvP 战斗
-- =============================================================
CREATE TABLE guilds (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  leader_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guild_members (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id),
  UNIQUE (user_id)  -- 单军团：一名玩家只属于一个军团
);

ALTER TABLE guilds ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_members ENABLE ROW LEVEL SECURITY;

-- guilds：登录用户可读全部；创建任意登录用户；改名/解散仅 leader
CREATE POLICY guilds_select ON guilds FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY guilds_insert ON guilds
  FOR INSERT WITH CHECK (auth.uid() = leader_user_id);
CREATE POLICY guilds_update ON guilds
  FOR UPDATE USING (auth.uid() = leader_user_id) WITH CHECK (auth.uid() = leader_user_id);
CREATE POLICY guilds_delete ON guilds
  FOR DELETE USING (auth.uid() = leader_user_id);

-- guild_members：登录用户可读全部；加入/退出仅本人
CREATE POLICY guild_members_select ON guild_members
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY guild_members_insert ON guild_members
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY guild_members_delete ON guild_members
  FOR DELETE USING (auth.uid() = user_id);

-- =============================================================
-- 17. PvP 挑战（1v1）：发起/结算/取消，结算由 SECURITY DEFINER RPC 写入
-- =============================================================
CREATE TABLE challenges (
  id text PRIMARY KEY,
  challenger_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenger_general_id text REFERENCES generals(id),
  target_general_id text REFERENCES generals(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  result text CHECK (result IN ('challenger_win','challenger_lose','draw')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
-- 双方（挑战者/被挑战者）可读自己的挑战；发起者写；结算由 RPC（SECURITY DEFINER）写
CREATE POLICY challenges_select ON challenges
  FOR SELECT USING (auth.uid() IN (challenger_user_id, target_user_id));
CREATE POLICY challenges_insert ON challenges
  FOR INSERT WITH CHECK (auth.uid() = challenger_user_id);

-- =============================================================
-- 18. 兵种单兵战力表（1-15 级）：供 SECURITY DEFINER RPC 查询
-- =============================================================
-- 本表镜像 shared/src/troops.ts 的 TROOP_CATALOG（单兵 power）。
-- 单一数据源是 shared/src/troops.ts；troop_stats 是给 RPC 用的 SQL 侧副本，改动须两边同步。
CREATE TABLE troop_stats (
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
CREATE TABLE pvp_battle_instances (
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

CREATE TABLE pvp_battle_reports (
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
CREATE POLICY pvp_battle_instances_select ON pvp_battle_instances
  FOR SELECT USING (auth.uid() IN (challenger_user_id, target_user_id));
-- 每名玩家只读自己的战报
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
--   effectiveWeaponTier = min(weaponTier, maxSoldierLevel)（无兵/无武器为 0）
--   generalSidePower = generalMultiplier × armyPower + effectiveWeaponTier*50
--   winProbability = 1/(1+exp(-slope*ln(attacker/defender))), slope=2.0
--   胜方轻损 15%、败方重损 70%（战损 = floor(count×rate)）
-- 胜负判定：完全均势 → 平局；否则用「双方 id + 挑战 id」哈希做确定性种子，
-- 模拟 combat.ts 的 mulberry32 种子随机（rand < winProbability）。
-- 注：plpgsql 函数内不允许显式 COMMIT/ROLLBACK，EXCEPTION 子句会为函数
-- 主体建立子事务，异常时自动回滚并重抛，保证整体原子性。
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
  v_ch_max_level integer;
  v_tg_max_level integer;
  v_ch_weapon_tier integer;
  v_tg_weapon_tier integer;
  v_ch_weapon_eff integer;
  v_tg_weapon_eff integer;
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
  -- 战损统计
  v_row record;
  v_lost integer;
  v_ch_casualties integer := 0;
  v_tg_casualties integer := 0;
  -- 战斗记录
  v_battle_id text;
  v_log jsonb;
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

  -- 3. 战力：armyPower = SUM(count × troop_stats.power) + maxSoldierLevel
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0),
         COALESCE(MAX(u.soldier_level), 0)
    INTO v_ch_army, v_ch_max_level
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_challenger_general_id;
  SELECT COALESCE(SUM(u.count * COALESCE(ts.power, 0)), 0),
         COALESCE(MAX(u.soldier_level), 0)
    INTO v_tg_army, v_tg_max_level
    FROM army_units u
    LEFT JOIN troop_stats ts ON ts.soldier_level = u.soldier_level
   WHERE u.general_id = p_target_general_id;

  -- 武器阶
  SELECT tier INTO v_ch_weapon_tier FROM weapons WHERE id = v_ch_weapon_id;
  SELECT tier INTO v_tg_weapon_tier FROM weapons WHERE id = v_tg_weapon_id;

  -- effectiveWeaponTier = min(tier, maxSoldierLevel)，无兵或无武器为 0
  v_ch_weapon_eff := CASE
    WHEN v_ch_weapon_tier IS NOT NULL AND v_ch_max_level > 0 THEN LEAST(v_ch_weapon_tier, v_ch_max_level)
    ELSE 0 END;
  v_tg_weapon_eff := CASE
    WHEN v_tg_weapon_tier IS NOT NULL AND v_tg_max_level > 0 THEN LEAST(v_tg_weapon_tier, v_tg_max_level)
    ELSE 0 END;

  -- generalMultiplier = 1 + (level-1)*0.05 + (stars-1)*0.10
  v_ch_mult := 1 + (v_ch_level - 1) * 0.05 + (v_ch_stars - 1) * 0.10;
  v_tg_mult := 1 + (v_tg_level - 1) * 0.05 + (v_tg_stars - 1) * 0.10;

  -- generalSidePower = multiplier × armyPower + weaponBonus（每阶 +50）
  v_ch_power := v_ch_mult * v_ch_army + v_ch_weapon_eff * 50;
  v_tg_power := v_tg_mult * v_tg_army + v_tg_weapon_eff * 50;

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

  -- 逐堆结算双方战损：count = count - floor(count×rate)，归零则删除
  FOR v_row IN SELECT id, count FROM army_units WHERE general_id = p_challenger_general_id LOOP
    v_lost := floor(v_row.count * v_ch_rate)::integer;
    v_ch_casualties := v_ch_casualties + v_lost;
    IF (v_row.count - v_lost) <= 0 THEN
      DELETE FROM army_units WHERE id = v_row.id;
    ELSE
      UPDATE army_units SET count = v_row.count - v_lost WHERE id = v_row.id;
    END IF;
  END LOOP;
  FOR v_row IN SELECT id, count FROM army_units WHERE general_id = p_target_general_id LOOP
    v_lost := floor(v_row.count * v_tg_rate)::integer;
    v_tg_casualties := v_tg_casualties + v_lost;
    IF (v_row.count - v_lost) <= 0 THEN
      DELETE FROM army_units WHERE id = v_row.id;
    ELSE
      UPDATE army_units SET count = v_row.count - v_lost WHERE id = v_row.id;
    END IF;
  END LOOP;

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

  -- 8. 更新挑战状态为已结算
  UPDATE challenges SET status = 'resolved', result = v_result, resolved_at = now()
   WHERE id = v_challenge_id;

  -- 9. 返回摘要
  RETURN jsonb_build_object(
    'challenge_id', v_challenge_id,
    'battle_instance_id', v_battle_id,
    'result', v_result,
    'winner', v_winner,
    'attacker', jsonb_build_object('general_id', p_challenger_general_id, 'power', v_ch_power_int, 'casualties', v_ch_casualties),
    'defender', jsonb_build_object('general_id', p_target_general_id, 'power', v_tg_power_int, 'casualties', v_tg_casualties)
  );

EXCEPTION WHEN OTHERS THEN
  -- 子事务自动回滚后重抛，保证整体原子性
  RAISE;
END;
$$;
