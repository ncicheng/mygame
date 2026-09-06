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
  `CREATE TABLE IF NOT EXISTS generals (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     level INTEGER NOT NULL,
     weapon_id TEXT REFERENCES weapons(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS army_units (
     id TEXT PRIMARY KEY,
     general_id TEXT NOT NULL REFERENCES generals(id) ON DELETE CASCADE,
     soldier_type TEXT NOT NULL,
     soldier_level INTEGER NOT NULL,
     count INTEGER NOT NULL
   )`,
];

/** 幂等建表：连接池存在时在首次使用时执行，之后跳过 */
export async function ensureSchema(db: Db): Promise<void> {
  if (!db || ensured.has(db)) {
    return;
  }
  for (const sql of CREATE_TABLES) {
    await db.query(sql);
  }
  ensured.add(db);
}