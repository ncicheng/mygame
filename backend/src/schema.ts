import type { Db } from './db.js';
import type { PoolClient } from 'pg';

/** 已初始化过的连接池，避免每次请求重跑建表语句 */
const ensured = new WeakSet<object>();

/** army_units 同兵种唯一约束名，与 CREATE TABLE 的自动命名保持一致 */
const ARMY_UNITS_UNIQUE_KEY = 'army_units_general_id_soldier_level_key';

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
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
     weapon_id TEXT REFERENCES weapons(id),
     world_id TEXT REFERENCES worlds(id),
     x INTEGER NOT NULL DEFAULT 0,
     y INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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