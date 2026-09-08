import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError } from './http.js';
import { fetchProfile } from './auth.js';
import { getActionPoints, trySpendActionPoints } from './actionPoints.js';
import { getTroopMaxUnlocked } from './progression.js';
import { ACTION_COSTS, getTroopType, type ActionPoints, type UserProfile } from '@mygame/shared';

/** 招募服务错误：携带 HTTP 状态码与可读信息 */
export class RecruitError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'RecruitError';
  }
}

/** 校验招募请求：武将必填，兵种等级 1-15，数量为正整数 */
function parseRecruit(body: unknown): { generalId: string; soldierLevel: number; count: number } {
  const input = (body ?? {}) as Record<string, unknown>;
  const generalId = typeof input.generalId === 'string' ? input.generalId.trim() : '';
  const soldierLevel = Number(input.soldierLevel);
  const count = Number(input.count);
  if (!generalId) {
    throw new RecruitError(400, '武将不能为空');
  }
  if (!Number.isInteger(soldierLevel) || soldierLevel < 1 || soldierLevel > 15) {
    throw new RecruitError(400, '兵种等级无效');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new RecruitError(400, '招募数量无效');
  }
  return { generalId, soldierLevel, count };
}

/** 招募：校验资源足够 → 扣基础资源 → 兵加入部队；消耗 1 行动点 */
export async function recruit(
  db: Db,
  token: string,
  body: unknown,
): Promise<{ user: UserProfile; actionPoints: ActionPoints }> {
  await ensureSchema(db);
  if (!db) {
    throw new RecruitError(503, '服务暂不可用（未连接数据库）');
  }

  const { generalId, soldierLevel, count } = parseRecruit(body);
  const troop = getTroopType(soldierLevel);
  if (!troop) {
    throw new RecruitError(400, '兵种等级无效');
  }

  const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (sessionRes.rows.length === 0) {
    throw new RecruitError(401, '未登录或会话已过期');
  }
  const userId = sessionRes.rows[0].user_id as string;

  const genRes = await db.query('SELECT id FROM generals WHERE id = $1 AND user_id = $2', [generalId, userId]);
  if (genRes.rows.length === 0) {
    throw new RecruitError(400, '武将不存在');
  }

  // 兵种解锁校验：只能招募已解锁的兵种（初始解锁低阶，更高阶需养成解锁）
  const maxUnlocked = await getTroopMaxUnlocked(db, userId);
  if (soldierLevel > maxUnlocked) {
    throw new RecruitError(400, '兵种未解锁');
  }

  const needFood = troop.cost.food * count;
  const needIron = troop.cost.iron * count;
  const needGold = troop.cost.gold * count;

  // 单事务：扣行动点 + 原子扣资源 + 兵加入部队。任一步失败整体回滚，
  // 不会出现「扣了行动点/资源但部队未建成」或并发招募超额消耗的脱节。
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const spent = await trySpendActionPoints(client, userId, ACTION_COSTS.recruit);
    if (!spent) {
      throw new RecruitError(400, '行动点不足');
    }

    // 原子扣资源：条件 UPDATE 只在余额足额时扣减，并发招募不会超额消耗
    const res = await client.query(
      `UPDATE resources SET food = food - $1, iron = iron - $2, gold = gold - $3
       WHERE user_id = $4 AND food >= $1 AND iron >= $2 AND gold >= $3`,
      [needFood, needIron, needGold, userId],
    );
    if (res.rowCount === 0) {
      throw new RecruitError(400, '基础资源不足，无法招募');
    }

    await client.query(
      `INSERT INTO army_units (id, general_id, soldier_type, soldier_level, count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (general_id, soldier_level)
       DO UPDATE SET count = army_units.count + EXCLUDED.count`,
      [randomUUID(), generalId, troop.name, soldierLevel, count],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { user: await fetchProfile(db, userId), actionPoints: await getActionPoints(db, userId) };
}