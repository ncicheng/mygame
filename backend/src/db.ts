import { Pool } from 'pg';

/** 数据库连接池；DATABASE_URL 未设置时为 null（本地无 Postgres 也可跑） */
export type Db = Pool | null;

/** 依据环境变量 DATABASE_URL 创建连接池，未配置则返回 null */
export function createDb(databaseUrl: string | undefined): Db {
  if (!databaseUrl) {
    return null;
  }
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
  });
}

/** 探测数据库连通性；连接失败返回 false（不抛出） */
export async function checkDb(db: Db): Promise<boolean> {
  if (!db) {
    return false;
  }
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}