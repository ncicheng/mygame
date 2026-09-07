import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError } from './http.js';
import { hashPassword, verifyPassword } from './password.js';
import { STARTER_ARMY, STARTER_GENERAL, STARTER_RESOURCES, STARTER_WEAPON } from './starter.js';
import { ensureDefaultWorld, findPlayerStartTile } from './world.js';
import { AP_MAX, type General, type Resources, type Soldier, type UserProfile } from '@mygame/shared';

/** 会话有效期：30 天 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 认证错误：携带 HTTP 状态码与可读信息 */
export class AuthError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'AuthError';
  }
}

/** 校验注册/登录输入；非法时抛出 AuthError(400) */
function parseCredentials(body: unknown): { username: string; password: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username) {
    throw new AuthError(400, '用户名不能为空');
  }
  if (username.length > 32) {
    throw new AuthError(400, '用户名最长 32 个字符');
  }
  if (!password) {
    throw new AuthError(400, '密码不能为空');
  }
  if (password.length > 128) {
    throw new AuthError(400, '密码最长 128 个字符');
  }
  return { username, password };
}

function newToken(): string {
  return randomBytes(32).toString('hex');
}

interface GeneralRow {
  id: string;
  name: string;
  level: number;
  stars: number;
  weapon_id: string | null;
  weapon_name: string | null;
  weapon_tier: number | null;
  soldier_type: string | null;
  soldier_level: number | null;
  count: number | null;
}

/** 组装用户档案：用户 + 资源 + 武将（含部队与武器） */
export async function fetchProfile(db: Db, userId: string): Promise<UserProfile> {
  await ensureSchema(db);
  if (!db) {
    throw new AuthError(503, '服务暂不可用（未连接数据库）');
  }

  const userRes = await db.query('SELECT id, username, created_at FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) {
    throw new AuthError(401, '未登录或会话已过期');
  }
  const userRow = userRes.rows[0];

  const resRes = await db.query('SELECT food, iron, rare, gold FROM resources WHERE user_id = $1', [userId]);
  const resources: Resources =
    resRes.rows.length > 0
      ? {
          food: resRes.rows[0].food,
          iron: resRes.rows[0].iron,
          rare: resRes.rows[0].rare,
          gold: resRes.rows[0].gold,
        }
      : { food: 0, iron: 0, rare: 0, gold: 0 };

  const progRes = await db.query('SELECT troop_max_unlocked FROM progression WHERE user_id = $1', [userId]);
  const troopMaxUnlocked = (progRes.rows[0]?.troop_max_unlocked as number) ?? 3;

  const genRes = await db.query(
    `SELECT g.id, g.name, g.level, g.stars, g.weapon_id,
            w.name AS weapon_name, w.tier AS weapon_tier,
            a.soldier_type, a.soldier_level, a.count
       FROM generals g
       LEFT JOIN weapons w ON w.id = g.weapon_id
       LEFT JOIN army_units a ON a.general_id = g.id
      WHERE g.user_id = $1
      ORDER BY g.created_at, a.soldier_level`,
    [userId],
  );

  const generals: General[] = [];
  for (const row of genRes.rows as GeneralRow[]) {
    let general = generals.find((g) => g.id === row.id);
    if (!general) {
      general = {
        id: row.id,
        name: row.name,
        level: row.level,
        stars: row.stars ?? 1,
        weapon:
          row.weapon_id && row.weapon_name !== null && row.weapon_tier !== null
            ? { id: row.weapon_id, name: row.weapon_name, tier: row.weapon_tier }
            : null,
        army: [],
      };
      generals.push(general);
    }
    if (row.soldier_type !== null && row.soldier_level !== null && row.count !== null) {
      general.army.push({
        soldierType: row.soldier_type,
        soldierLevel: row.soldier_level,
        count: row.count,
      } satisfies Soldier);
    }
  }

  return {
    id: userRow.id,
    username: userRow.username,
    registeredAt: new Date(userRow.created_at).toISOString(),
    resources,
    troopMaxUnlocked,
    generals,
  };
}

/** 是否为 Postgres 唯一约束冲突（SQLSTATE 23505），并附上冲突的约束名 */
function uniqueViolation(err: unknown): { constraint?: string } | null {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' ? e : null;
}

/** 注册：创建用户 + 初始武将/武器/部队 + 初始资源，签发会话 token */
export async function register(db: Db, body: unknown): Promise<{ token: string; user: UserProfile }> {
  const { username, password } = parseCredentials(body);

  await ensureSchema(db);
  if (!db) {
    throw new AuthError(503, '服务暂不可用（未连接数据库）');
  }

  // 快速路径：已有同名用户直接 409（并发窗口由下方事务内的唯一约束兜底）
  const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) {
    throw new AuthError(409, '用户名已存在');
  }

  // 进入默认世界
  const worldId = await ensureDefaultWorld(db);

  const userId = randomUUID();
  const weaponId = randomUUID();
  const generalId = randomUUID();
  const passwordHash = await hashPassword(password);
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // 落位主城格可能与他人并发撞格，由 cities 唯一约束兜底：冲突则换格重试。
  // 事务内：重名并发由 users 唯一约束兜底 → 捕获 23505 返回 409（而非 500）。
  let placed = false;
  for (let attempt = 0; attempt < 5 && !placed; attempt++) {
    const start = await findPlayerStartTile(db, worldId);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [
        userId,
        username,
        passwordHash,
      ]);
      await client.query(
        'INSERT INTO resources (user_id, food, iron, rare, gold) VALUES ($1, $2, $3, $4, $5)',
        [
          userId,
          STARTER_RESOURCES.food,
          STARTER_RESOURCES.iron,
          STARTER_RESOURCES.rare,
          STARTER_RESOURCES.gold,
        ],
      );
      // 先建武将（weapon_id 置空），再建武器、再回填武将武器外键：
      // 保证 weapons.general_id → generals(id) 外键可满足（两者互为外键，只能错序补齐）。
      await client.query(
        'INSERT INTO generals (id, user_id, name, level, stars, weapon_id, world_id, x, y) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)',
        [generalId, userId, STARTER_GENERAL.name, STARTER_GENERAL.level, 1, worldId, start.x, start.y],
      );
      await client.query('INSERT INTO weapons (id, user_id, name, tier, general_id) VALUES ($1, $2, $3, $4, $5)', [
        weaponId,
        userId,
        STARTER_WEAPON.name,
        STARTER_WEAPON.tier,
        generalId,
      ]);
      await client.query('UPDATE generals SET weapon_id = $1 WHERE id = $2', [weaponId, generalId]);
      for (const unit of STARTER_ARMY) {
        await client.query(
          'INSERT INTO army_units (id, general_id, soldier_type, soldier_level, count) VALUES ($1, $2, $3, $4, $5)',
          [randomUUID(), generalId, unit.soldierType, unit.soldierLevel, unit.count],
        );
      }
      // 主城与行动点：新玩家满行动点入场
      await client.query(
        'INSERT INTO cities (id, world_id, x, y, name, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), worldId, start.x, start.y, `${username}的主城`, userId],
      );
      await client.query('INSERT INTO action_points (user_id, current, max) VALUES ($1, $2, $3)', [
        userId,
        AP_MAX,
        AP_MAX,
      ]);
      // 养成进度：初始解锁低阶兵种（1-3 级），更高阶需消耗稀有材料逐级解锁
      await client.query('INSERT INTO progression (user_id, troop_max_unlocked) VALUES ($1, $2)', [userId, 3]);
      await client.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [
        token,
        userId,
        expiresAt,
      ]);
      await client.query('COMMIT');
      placed = true;
    } catch (err) {
      await client.query('ROLLBACK');
      const violation = uniqueViolation(err);
      if (violation?.constraint === 'users_username_key') {
        // 并发重名：唯一约束兜底 → 明确返回 409，而非未预期的 500
        throw new AuthError(409, '用户名已存在');
      }
      if (violation?.constraint === 'cities_world_id_x_y_key') {
        continue; // 与他人并发撞落位格：换格重试
      }
      throw err;
    } finally {
      client.release();
    }
  }

  if (!placed) {
    throw new AuthError(500, '世界已无可用落点，注册失败');
  }

  const user = await fetchProfile(db, userId);
  return { token, user };
}

/** 登录：校验密码，签发会话 token */
export async function login(db: Db, body: unknown): Promise<{ token: string; user: UserProfile }> {
  const { username, password } = parseCredentials(body);

  await ensureSchema(db);
  if (!db) {
    throw new AuthError(503, '服务暂不可用（未连接数据库）');
  }

  const res = await db.query('SELECT id, password_hash FROM users WHERE username = $1', [username]);
  if (res.rows.length === 0) {
    throw new AuthError(401, '用户名或密码错误');
  }
  const row = res.rows[0];
  const ok = await verifyPassword(password, row.password_hash as string);
  if (!ok) {
    throw new AuthError(401, '用户名或密码错误');
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    row.id,
    expiresAt,
  ]);

  const user = await fetchProfile(db, row.id);
  return { token, user };
}

/** 登出：删除会话 token */
export async function logout(db: Db, token: string): Promise<void> {
  await ensureSchema(db);
  if (!db) {
    throw new AuthError(503, '服务暂不可用（未连接数据库）');
  }
  const res = await db.query('DELETE FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (res.rowCount === 0) {
    throw new AuthError(401, '未登录或会话已过期');
  }
}

/** 按 token 取当前用户档案 */
export async function getMe(db: Db, token: string): Promise<UserProfile> {
  await ensureSchema(db);
  if (!db) {
    throw new AuthError(503, '服务暂不可用（未连接数据库）');
  }
  const res = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (res.rows.length === 0) {
    throw new AuthError(401, '未登录或会话已过期');
  }
  return fetchProfile(db, res.rows[0].user_id);
}