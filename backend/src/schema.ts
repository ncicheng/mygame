import type { Db } from './db.js';
import type { PoolClient } from 'pg';

/** 已初始化过的连接池，避免每次请求重跑建表语句 */
const ensured = new WeakSet<object>();

/** army_units 同兵种唯一约束名，与 CREATE TABLE 的自动命名保持一致 */
const ARMY_UNITS_UNIQUE_KEY = 'army_units_general_id_soldier_level_key';

/** marches 上「同一武将同时只允许一条 active 行军」的部分唯一索引名 */
const MARCH_ACTIVE_UNIQUE = 'marches_general_id_active_unique';

const CREATE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     username TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS resources (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     food INTEGER NOT NULL,
     iron INTEGER NOT NULL,
     rare INTEGER NOT NULL,
     gold INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS weapons (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     tier INTEGER NOT NULL,
     general_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS worlds (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     seed INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS world_tiles (
     world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
     x INTEGER NOT NULL,
     y INTEGER NOT NULL,
     terrain TEXT NOT NULL CHECK (terrain IN ('g','f','m','w')),
     PRIMARY KEY (world_id, x, y)
   )`,
  `CREATE TABLE IF NOT EXISTS cities (
     id TEXT PRIMARY KEY,
     world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
     x INTEGER NOT NULL,
     y INTEGER NOT NULL,
     name TEXT NOT NULL,
     owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (world_id, x, y)
   )`,
  `CREATE TABLE IF NOT EXISTS wildlands (
     id TEXT PRIMARY KEY,
     world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
     x INTEGER NOT NULL,
     y INTEGER NOT NULL,
     name TEXT NOT NULL,
     strength INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS generals (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     level INTEGER NOT NULL,
     stars INTEGER NOT NULL DEFAULT 1,
     weapon_id TEXT REFERENCES weapons(id),
     world_id TEXT REFERENCES worlds(id),
     x INTEGER NOT NULL DEFAULT 0,
     y INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS progression (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     troop_max_unlocked INTEGER NOT NULL DEFAULT 3
   )`,
  `CREATE TABLE IF NOT EXISTS army_units (
     id TEXT PRIMARY KEY,
     general_id TEXT NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
     soldier_type TEXT NOT NULL,
     soldier_level INTEGER NOT NULL,
     count INTEGER NOT NULL,
     UNIQUE (general_id, soldier_level)
   )`,
  `CREATE TABLE IF NOT EXISTS action_points (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     current INTEGER NOT NULL,
     max INTEGER NOT NULL,
     last_recovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS marches (
     id TEXT PRIMARY KEY,
     world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
     general_id TEXT NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     origin_x INTEGER NOT NULL,
     origin_y INTEGER NOT NULL,
     target_x INTEGER NOT NULL,
     target_y INTEGER NOT NULL,
     departed_at TIMESTAMPTZ NOT NULL,
     arrives_at TIMESTAMPTZ NOT NULL,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','arrived','cancelled')),
     cancelled_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS battle_instances (
     id TEXT PRIMARY KEY,
     world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
     attacker_general_id TEXT NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
     attacker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     defender_wildland_id TEXT NOT NULL REFERENCES wildlands(id) ON DELETE CASCADE,
     attacker_power INTEGER NOT NULL,
     defender_power INTEGER NOT NULL,
     winner TEXT NOT NULL CHECK (winner IN ('attacker','defender')),
     attacker_casualties INTEGER NOT NULL,
     defender_casualties INTEGER NOT NULL,
     dropped_rare INTEGER NOT NULL DEFAULT 0,
     skill_used BOOLEAN NOT NULL DEFAULT false,
     log JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS battle_reports (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     general_id TEXT NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
     battle_instance_id TEXT NOT NULL REFERENCES battle_instances(id) ON DELETE CASCADE,
     wildland_id TEXT NOT NULL REFERENCES wildlands(id) ON DELETE CASCADE,
     wildland_name TEXT NOT NULL,
     victory BOOLEAN NOT NULL,
     attacker_casualties INTEGER NOT NULL,
     defender_casualties INTEGER NOT NULL,
     dropped_rare INTEGER NOT NULL DEFAULT 0,
     log JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

/** 幂等建表：连接池存在时在首次使用时执行，之后跳过 */
export async function ensureSchema(db: Db): Promise<void> {
  if (!db || ensured.has(db)) {
    return;
  }
  const client = await db.connect();
  try {
    // 持有全局建表锁，避免多进程并发 CREATE TABLE IF NOT EXISTS 时
    // 匿名类型名重复竞态（duplicate key violates pg_type_typname_nsp_index）
    await client.query('SELECT pg_advisory_lock(7263)');
    try {
      for (const sql of CREATE_TABLES) {
        await client.query(sql);
      }
      // 旧库补齐 army_units 唯一约束（CREATE TABLE IF NOT EXISTS 不会给已存在表加约束）
      await ensureArmyUnitsConstraint(client);
      // 旧库补齐 marches 部分唯一索引（并发防重复行军的最后防线）
      await ensureMarchActiveUnique(client);
      // 旧库补齐野地掉落与刷新字段（CREATE TABLE IF NOT EXISTS 不会给已存在表加列）
      await ensureWildlandRefreshColumns(client);
      // 旧库补齐武将星级列（养成任务新增，CREATE TABLE IF NOT EXISTS 不会给已存在表加列）
      await ensureGeneralsStarsColumn(client);
      // 旧库补齐城池 (world_id, x, y) 唯一约束（防并发注册同格；CREATE TABLE 不会给已存在表加约束）
      await ensureCitiesTileUnique(client);
      // 旧库补齐 weapons.general_id 外键（CREATE TABLE 顺序不便建循环外键，迁移时补）
      await ensureWeaponsGeneralFk(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(7263)');
    }
  } finally {
    client.release();
  }
  ensured.add(db);
}

/** 幂等补齐 army_units 的 UNIQUE (general_id, soldier_level) 约束。
 * 旧库由早期 schema 创建时缺该约束，会让 recruit 的
 * ON CONFLICT (general_id, soldier_level) 在运行时抛错。
 * 缺失时先合并重复行（同兵种数量求和保留一行），再补约束。
 */
export async function ensureArmyUnitsConstraint(client: PoolClient): Promise<void> {
  const has = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conname = $1 AND conrelid = 'army_units'::regclass`,
    [ARMY_UNITS_UNIQUE_KEY],
  );
  if (has.rowCount) {
    return; // 已存在，幂等跳过
  }
  // 把每组 (general_id, soldier_level) 重复行的数量求和写入保留行
  await client.query(
    `UPDATE army_units a
     SET count = (
       SELECT sum(u.count) FROM army_units u
       WHERE u.general_id = a.general_id AND u.soldier_level = a.soldier_level
     )
     WHERE a.id IN (
       SELECT min(id) FROM army_units
       GROUP BY general_id, soldier_level
       HAVING count(*) > 1
     )`,
  );
  // 删除每组除保留行（id 最小）外的重复行
  await client.query(
    `DELETE FROM army_units a
     USING army_units b
     WHERE a.general_id = b.general_id
       AND a.soldier_level = b.soldier_level
       AND a.id > b.id`,
  );
  // 补唯一约束（约束名为固定常量，非用户输入，可直接拼接）
  await client.query(
    `ALTER TABLE army_units
     ADD CONSTRAINT ${ARMY_UNITS_UNIQUE_KEY} UNIQUE (general_id, soldier_level)`,
  );
}

/** 幂等补齐 marches 的部分唯一索引：同一武将同时只能有一条 active 行军。
 * 应用层 findActiveMarch 先检查是快速路径；此索引是并发下两道请求同时通过
 * 检查后仍可能插入两条 active 行军的最后防线（唯一索引兜底）。
 */
export async function ensureMarchActiveUnique(client: PoolClient): Promise<void> {
  // 已存在则跳过，幂等（避免每次启动都重跑去重）
  const has = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
    [MARCH_ACTIVE_UNIQUE],
  );
  if (has.rowCount) {
    return;
  }
  // 旧库可能因此前「并发双重行军无唯一性兜底」的 bug，遗留同一武将多条 active 行军。
  // 直接建部分唯一索引会抛 23505 并让 ensureSchema 启动失败，故先按确定规则去重：
  // 每名武将保留「出发最早的一条 active」（departed_at 相同则以 id 最小者），其余置为 cancelled。
  await client.query(
    `UPDATE marches m
     SET status = 'cancelled', cancelled_at = now()
     WHERE m.status = 'active'
       AND m.id NOT IN (
         SELECT DISTINCT ON (general_id) id
         FROM marches
         WHERE status = 'active'
         ORDER BY general_id, departed_at, id
       )`,
  );
  // 补部分唯一索引（索引名为固定常量，非用户输入，可直接拼接）
  await client.query(
    `CREATE UNIQUE INDEX ${MARCH_ACTIVE_UNIQUE}
       ON marches (general_id)
      WHERE status = 'active'`,
  );
}

/** 幂等补齐野地的稀有材料掉落量与刷新字段：
 * 旧库由早期 schema 创建时缺这两列，会让打野遭遇写入与刷新失败。
 * ADD COLUMN IF NOT EXISTS 天然幂等，直接执行即可。 */
export async function ensureWildlandRefreshColumns(client: PoolClient): Promise<void> {
  await client.query('ALTER TABLE wildlands ADD COLUMN IF NOT EXISTS drop INTEGER NOT NULL DEFAULT 0');
  await client.query('ALTER TABLE wildlands ADD COLUMN IF NOT EXISTS defeated_at TIMESTAMPTZ');
  // 旧库已存在的野地没有掉落值，按强度补算
  await client.query(`UPDATE wildlands SET drop = GREATEST(1, round(strength / 10.0)) WHERE drop = 0`);
}

/** 幂等补齐武将的星级列（养成任务新增）：
 * 旧库由早期 schema 创建时缺该列，会让 fetchProfile/升星失败。
 * ADD COLUMN IF NOT EXISTS 天然幂等，直接执行即可。 */
export async function ensureGeneralsStarsColumn(client: PoolClient): Promise<void> {
  await client.query('ALTER TABLE generals ADD COLUMN IF NOT EXISTS stars INTEGER NOT NULL DEFAULT 1');
}

/** 幂等补齐 cities 的 UNIQUE (world_id, x, y) 约束：
 * 旧库缺该约束时，并发注册可能把两名玩家放到同一格。
 * 缺失时先清理同格重复城池（保留 created_at 最早的一城，其余删除），再补唯一约束。 */
export async function ensureCitiesTileUnique(client: PoolClient): Promise<void> {
  const has = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conname = $1 AND conrelid = 'cities'::regclass`,
    ['cities_world_id_x_y_key'],
  );
  if (has.rowCount) {
    return; // 已存在，幂等跳过
  }
  // 删除每组 (world_id, x, y) 中保留行（created_at 最早、并列取 id 最小）之外的重复城池
  await client.query(
    `DELETE FROM cities c
     USING cities d
     WHERE c.world_id = d.world_id AND c.x = d.x AND c.y = d.y
       AND (c.created_at > d.created_at OR (c.created_at = d.created_at AND c.id > d.id))`,
  );
  // 补唯一约束（约束名为固定常量，非用户输入，可直接拼接）
  await client.query(
    `ALTER TABLE cities
     ADD CONSTRAINT cities_world_id_x_y_key UNIQUE (world_id, x, y)`,
  );
}

/** 幂等补齐 weapons.general_id 的外键：武器应归属某武将。
 * CREATE_TABLES 里 weapons 先于 generals 建表，无法在 DDL 里声明循环外键，
 * 故在各表都建成后经此函数补齐。缺失时先把指向不存在武将的孤儿武器置空，再加外键。 */
export async function ensureWeaponsGeneralFk(client: PoolClient): Promise<void> {
  const has = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conname = $1 AND conrelid = 'weapons'::regclass`,
    ['weapons_general_id_fkey'],
  );
  if (has.rowCount) {
    return; // 已存在，幂等跳过
  }
  // 清理孤儿：general_id 指向不存在武将的武器 → 置空（避免加外键失败）
  await client.query(
    `UPDATE weapons SET general_id = NULL
      WHERE general_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM generals WHERE id = weapons.general_id)`,
  );
  // 补外键（约束名为固定常量，非用户输入，可直接拼接）
  await client.query(
    `ALTER TABLE weapons
     ADD CONSTRAINT weapons_general_id_fkey FOREIGN KEY (general_id) REFERENCES generals(id) ON DELETE SET NULL`,
  );
}