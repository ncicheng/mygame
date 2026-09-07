import type { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError } from './http.js';
import { fetchProfile } from './auth.js';
import {
  GENERAL_LEVEL_MAX,
  GENERAL_STAR_MAX,
  INITIAL_TROOP_UNLOCK,
  TROOP_LEVEL_MAX,
  WEAPON_TIER_MAX,
  generalLevelUpCost,
  generalStarUpCost,
  getWeaponName,
  troopUnlockCost,
  weaponUpgradeCost,
  type UserProfile,
} from '@mygame/shared';

/** 养成服务错误：携带 HTTP 状态码与可读信息 */
export class ProgressionError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'ProgressionError';
  }
}

/** 取会话对应用户 id；未登录抛 401 */
async function userIdForToken(db: Db, token: string): Promise<string> {
  if (!db) {
    throw new ProgressionError(503, '服务暂不可用（未连接数据库）');
  }
  const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (sessionRes.rows.length === 0) {
    throw new ProgressionError(401, '未登录或会话已过期');
  }
  return sessionRes.rows[0].user_id as string;
}

/** 校验武将归属并返回武将 id；非本人或不存在抛 400 */
async function requireOwnGeneral(db: Db, userId: string, generalId: string): Promise<void> {
  if (!db) {
    throw new ProgressionError(503, '服务暂不可用（未连接数据库）');
  }
  const res = await db.query('SELECT id FROM generals WHERE id = $1 AND user_id = $2', [generalId, userId]);
  if (res.rows.length === 0) {
    throw new ProgressionError(400, '武将不存在');
  }
}

/** 稀有材料足额则扣除并返回 true，不足返回 false。 */
async function trySpendRare(db: Db, userId: string, cost: number): Promise<boolean> {
  if (!db) {
    return false;
  }
  const res = await db.query('SELECT rare FROM resources WHERE user_id = $1', [userId]);
  if (res.rows.length === 0) {
    return false;
  }
  const have = res.rows[0].rare as number;
  if (have < cost) {
    return false;
  }
  await db.query('UPDATE resources SET rare = rare - $1 WHERE user_id = $2', [cost, userId]);
  return true;
}

/** 武将升级：等级 +1，消耗稀有材料；升到上限后拒绝 */
export async function generalLevelUp(db: Db, token: string, body: unknown): Promise<{ user: UserProfile }> {
  await ensureSchema(db);
  if (!db) {
    throw new ProgressionError(503, '服务暂不可用（未连接数据库）');
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const generalId = typeof input.generalId === 'string' ? input.generalId.trim() : '';
  if (!generalId) {
    throw new ProgressionError(400, '武将不能为空');
  }
  const userId = await userIdForToken(db, token);
  await requireOwnGeneral(db, userId, generalId);

  const genRes = await db.query('SELECT level FROM generals WHERE id = $1', [generalId]);
  const level = genRes.rows[0].level as number;
  if (level >= GENERAL_LEVEL_MAX) {
    throw new ProgressionError(400, '武将已满级');
  }
  const cost = generalLevelUpCost(level);
  if (!(await trySpendRare(db, userId, cost))) {
    throw new ProgressionError(400, '稀有材料不足，无法升级');
  }
  await db.query('UPDATE generals SET level = level + 1 WHERE id = $1', [generalId]);
  return { user: await fetchProfile(db, userId) };
}

/** 武将升星：星级 +1，消耗稀有材料；满星后拒绝 */
export async function generalStarUp(db: Db, token: string, body: unknown): Promise<{ user: UserProfile }> {
  await ensureSchema(db);
  if (!db) {
    throw new ProgressionError(503, '服务暂不可用（未连接数据库）');
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const generalId = typeof input.generalId === 'string' ? input.generalId.trim() : '';
  if (!generalId) {
    throw new ProgressionError(400, '武将不能为空');
  }
  const userId = await userIdForToken(db, token);
  await requireOwnGeneral(db, userId, generalId);

  const genRes = await db.query('SELECT stars FROM generals WHERE id = $1', [generalId]);
  const stars = genRes.rows[0].stars as number;
  if (stars >= GENERAL_STAR_MAX) {
    throw new ProgressionError(400, '武将已满星');
  }
  const cost = generalStarUpCost(stars);
  if (!(await trySpendRare(db, userId, cost))) {
    throw new ProgressionError(400, '稀有材料不足，无法升星');
  }
  await db.query('UPDATE generals SET stars = stars + 1 WHERE id = $1', [generalId]);
  return { user: await fetchProfile(db, userId) };
}

/** 武器升阶：武将武器阶 +1（名称随表更新），消耗稀有材料；满阶后拒绝 */
export async function weaponUpgrade(db: Db, token: string, body: unknown): Promise<{ user: UserProfile }> {
  await ensureSchema(db);
  if (!db) {
    throw new ProgressionError(503, '服务暂不可用（未连接数据库）');
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const generalId = typeof input.generalId === 'string' ? input.generalId.trim() : '';
  if (!generalId) {
    throw new ProgressionError(400, '武将不能为空');
  }
  const userId = await userIdForToken(db, token);
  await requireOwnGeneral(db, userId, generalId);

  const wepRes = await db.query('SELECT w.id, w.tier FROM weapons w JOIN generals g ON g.weapon_id = w.id WHERE g.id = $1', [
    generalId,
  ]);
  if (wepRes.rows.length === 0) {
    throw new ProgressionError(400, '武将未装备武器');
  }
  const weaponId = wepRes.rows[0].id as string;
  const tier = wepRes.rows[0].tier as number;
  if (tier >= WEAPON_TIER_MAX) {
    throw new ProgressionError(400, '武器已满阶');
  }
  const cost = weaponUpgradeCost(tier);
  if (!(await trySpendRare(db, userId, cost))) {
    throw new ProgressionError(400, '稀有材料不足，无法强化');
  }
  const nextTier = tier + 1;
  const name = getWeaponName(nextTier);
  await db.query('UPDATE weapons SET tier = $1, name = $2 WHERE id = $3', [nextTier, name, weaponId]);
  return { user: await fetchProfile(db, userId) };
}

/** 兵种解锁：逐级解锁更高阶兵种，消耗稀有材料；须按顺序解锁 */
export async function troopUnlock(db: Db, token: string, body: unknown): Promise<{ user: UserProfile }> {
  await ensureSchema(db);
  if (!db) {
    throw new ProgressionError(503, '服务暂不可用（未连接数据库）');
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const troopLevel = Number(input.troopLevel);
  if (!Number.isInteger(troopLevel) || troopLevel < 1 || troopLevel > TROOP_LEVEL_MAX) {
    throw new ProgressionError(400, '兵种等级无效');
  }
  const userId = await userIdForToken(db, token);

  const progRes = await db.query('SELECT troop_max_unlocked FROM progression WHERE user_id = $1', [userId]);
  const currentMax = (progRes.rows[0]?.troop_max_unlocked as number) ?? INITIAL_TROOP_UNLOCK;
  if (troopLevel <= currentMax) {
    throw new ProgressionError(400, '该兵种已解锁');
  }
  if (troopLevel !== currentMax + 1) {
    throw new ProgressionError(400, '须逐级解锁更高阶兵种');
  }
  const cost = troopUnlockCost(troopLevel);
  if (!(await trySpendRare(db, userId, cost))) {
    throw new ProgressionError(400, '稀有材料不足，无法解锁');
  }
  // 幂等 upsert：存量用户（progression 表引入前注册、无行）也能真正写入解锁进度，
  // 避免 UPDATE 命中 0 行导致「扣了稀有材料但进度不生效」的静默 no-op。
  await db.query(
    `INSERT INTO progression (user_id, troop_max_unlocked) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET troop_max_unlocked = EXCLUDED.troop_max_unlocked`,
    [userId, troopLevel],
  );
  return { user: await fetchProfile(db, userId) };
}

/** 读取玩家已解锁的最高兵种等级（招募解锁校验用） */
export async function getTroopMaxUnlocked(db: Db, userId: string): Promise<number> {
  if (!db) {
    return INITIAL_TROOP_UNLOCK;
  }
  const res = await db.query('SELECT troop_max_unlocked FROM progression WHERE user_id = $1', [userId]);
  return (res.rows[0]?.troop_max_unlocked as number) ?? INITIAL_TROOP_UNLOCK;
}
