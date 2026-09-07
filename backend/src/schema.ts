import type { Db } from './db.js';

/** 已初始化过的连接池，避免每次请求重跑建表语句 */
const ensured = new WeakSet<object>();

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
     count INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS action_points (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     current INTEGER NOT NULL,
     max INTEGER NOT NULL,
     last_recovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    } finally {
      await client.query('SELECT pg_advisory_unlock(7263)');
    }
  } finally {
    client.release();
  }
  ensured.add(db);
}