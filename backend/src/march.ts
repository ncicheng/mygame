import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError } from './http.js';
import { getActionPoints, trySpendActionPoints } from './actionPoints.js';
import {
  ACTION_COSTS,
  MARCH_TILE_MS,
  type ActionPoints,
  type MarchResponse,
  type MarchStatus,
  type WorldMarch,
} from '@mygame/shared';

/** 行军服务错误：携带 HTTP 状态码与可读信息 */
export class MarchError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'MarchError';
  }
}

/** 行军插值的行程：起点/目标 + 出发/到达时间（纯数据，供纯函数使用） */
export interface MarchSchedule {
  originX: number;
  originY: number;
  targetX: number;
  targetY: number;
  departedAt: Date;
  arrivesAt: Date;
}

/** 格子坐标 */
export interface Tile {
  x: number;
  y: number;
}

/** 曼哈顿距离：行军按网格逐格推进，距离 = 横向差 + 纵向差 */
export function manhattanDistance(a: Tile, b: Tile): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 到达时间 = 出发时间 + 距离 × 每格耗时 */
export function computeArrivalAt(departedMs: number, distanceTiles: number): Date {
  return new Date(departedMs + distanceTiles * MARCH_TILE_MS);
}

/** 行军中某时刻的格位置：按进度沿横向→纵向逐格推进，钳制在起点与目标之间 */
export function marchPositionAt(schedule: MarchSchedule, nowMs: number): Tile {
  const departed = schedule.departedAt.getTime();
  const arrives = schedule.arrivesAt.getTime();
  const distance = manhattanDistance(
    { x: schedule.originX, y: schedule.originY },
    { x: schedule.targetX, y: schedule.targetY },
  );
  if (distance === 0) {
    return { x: schedule.targetX, y: schedule.targetY };
  }

  const span = arrives - departed;
  const progress = span > 0 ? Math.min(1, Math.max(0, (nowMs - departed) / span)) : 1;
  const traveled = Math.min(distance, Math.floor(progress * distance));

  // 横向优先：先向目标走满 x，再走 y
  let x = schedule.originX;
  let y = schedule.originY;
  const dx = Math.sign(schedule.targetX - schedule.originX);
  const dy = Math.sign(schedule.targetY - schedule.originY);
  for (let step = 0; step < traveled; step++) {
    if (x !== schedule.targetX) {
      x += dx;
    } else {
      y += dy;
    }
  }
  return { x, y };
}

/** 解析行军请求：武将必填，目标格为整数坐标 */
function parseMarch(body: unknown): { generalId: string; targetX: number; targetY: number } {
  const input = (body ?? {}) as Record<string, unknown>;
  const generalId = typeof input.generalId === 'string' ? input.generalId.trim() : '';
  const targetX = Number(input.targetX);
  const targetY = Number(input.targetY);
  if (!generalId) {
    throw new MarchError(400, '请选择要行军的部队');
  }
  if (!Number.isInteger(targetX) || !Number.isInteger(targetY)) {
    throw new MarchError(400, '目标格坐标无效');
  }
  return { generalId, targetX, targetY };
}

/** 查询某武将当前进行中的行军（无则 null） */
export async function findActiveMarch(db: Db, generalId: string): Promise<WorldMarch | null> {
  if (!db) {
    return null;
  }
  const res = await db.query(
    `SELECT id, general_id, origin_x, origin_y, target_x, target_y, departed_at, arrives_at
       FROM marches
      WHERE general_id = $1 AND status = 'active'`,
    [generalId],
  );
  return toWorldMarch(res.rows[0]);
}

/** 数据库行 → WorldMarch（时间序列化为 ISO 字符串） */
function toWorldMarch(row: Record<string, unknown> | undefined): WorldMarch | null {
  if (!row) {
    return null;
  }
  return {
    id: row.id as string,
    generalId: row.general_id as string,
    originX: row.origin_x as number,
    originY: row.origin_y as number,
    targetX: row.target_x as number,
    targetY: row.target_y as number,
    departedAt: new Date(row.departed_at as string).toISOString(),
    arrivesAt: new Date(row.arrives_at as string).toISOString(),
    status: (row.status === 'cancelled' || row.status === 'arrived' ? row.status : 'active') as MarchStatus,
  };
}

/** 发布行军命令：校验部队归属与目标可达 → 扣行动点 → 建行军记录 */
export async function createMarch(db: Db, token: string, body: unknown): Promise<MarchResponse> {
  await ensureSchema(db);
  if (!db) {
    throw new MarchError(503, '服务暂不可用（未连接数据库）');
  }

  const { generalId, targetX, targetY } = parseMarch(body);

  const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (sessionRes.rows.length === 0) {
    throw new MarchError(401, '未登录或会话已过期');
  }
  const userId = sessionRes.rows[0].user_id as string;

  const genRes = await db.query(
    'SELECT world_id, x, y FROM generals WHERE id = $1 AND user_id = $2',
    [generalId, userId],
  );
  if (genRes.rows.length === 0) {
    throw new MarchError(400, '武将不存在');
  }
  const general = genRes.rows[0] as { world_id: string; x: number; y: number };
  const worldId = general.world_id;

  // 目标可达性：必须在地图内，且不能是自身所在格
  const worldRes = await db.query('SELECT width, height FROM worlds WHERE id = $1', [worldId]);
  const world = worldRes.rows[0] as { width: number; height: number };
  if (targetX < 0 || targetY < 0 || targetX >= world.width || targetY >= world.height) {
    throw new MarchError(400, '目标格超出地图范围');
  }
  if (targetX === general.x && targetY === general.y) {
    throw new MarchError(400, '部队已在目标格');
  }

  // 一支部队同时只允许一个行军命令
  const existing = await findActiveMarch(db, generalId);
  if (existing) {
    throw new MarchError(400, '该部队正在行军中');
  }

  const spent = await trySpendActionPoints(db, userId, ACTION_COSTS.march);
  if (!spent) {
    throw new MarchError(400, '行动点不足');
  }

  const now = new Date();
  const distance = manhattanDistance({ x: general.x, y: general.y }, { x: targetX, y: targetY });
  const arrivesAt = computeArrivalAt(now.getTime(), distance);
  const marchId = randomUUID();

  await db.query(
    `INSERT INTO marches (id, world_id, general_id, user_id, origin_x, origin_y, target_x, target_y, departed_at, arrives_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      marchId,
      worldId,
      generalId,
      userId,
      general.x,
      general.y,
      targetX,
      targetY,
      now,
      arrivesAt,
    ],
  );

  const march: WorldMarch = {
    id: marchId,
    generalId,
    originX: general.x,
    originY: general.y,
    targetX,
    targetY,
    departedAt: now.toISOString(),
    arrivesAt: arrivesAt.toISOString(),
    status: 'active',
  };
  const actionPoints: ActionPoints = await getActionPoints(db, userId);
  return { march, actionPoints };
}

/** 取消行军：部队返回起点，行军命令置为已取消；行动点不退还 */
export async function cancelMarch(db: Db, token: string, marchId: string): Promise<{ march: WorldMarch; actionPoints: ActionPoints }> {
  await ensureSchema(db);
  if (!db) {
    throw new MarchError(503, '服务暂不可用（未连接数据库）');
  }

  const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (sessionRes.rows.length === 0) {
    throw new MarchError(401, '未登录或会话已过期');
  }
  const userId = sessionRes.rows[0].user_id as string;

  const res = await db.query(
    `UPDATE marches SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'active'
      RETURNING id, general_id, origin_x, origin_y, target_x, target_y, departed_at, arrives_at`,
    [marchId, userId],
  );
  if (res.rows.length === 0) {
    throw new MarchError(400, '行军不存在或已结束');
  }
  const row = res.rows[0];

  // 部队回到起点（取消即返回出发格）
  await db.query('UPDATE generals SET x = $1, y = $2 WHERE id = $3', [
    row.origin_x,
    row.origin_y,
    row.general_id,
  ]);

  const march = toWorldMarch({ ...row, status: 'cancelled' })!;
  const actionPoints: ActionPoints = await getActionPoints(db, userId);
  return { march, actionPoints };
}

/** 结算已到期的行军：到达后把部队位置落库为目标格，行军置为已到达。
 *  worldId 为 null 时结算全部世界（服务器时钟 tick 用）。 */
export async function finalizeArrivedMarches(db: Db, worldId: string | null): Promise<void> {
  if (!db) {
    return;
  }
  const params: unknown[] = [];
  let where = 'WHERE status = $1 AND arrives_at <= now()';
  params.push('active');
  if (worldId !== null) {
    where += ' AND world_id = $' + (params.length + 1);
    params.push(worldId);
  }
  const res = await db.query(
    `SELECT id, general_id, target_x, target_y FROM marches ${where}`,
    params,
  );
  if (res.rows.length === 0) {
    return;
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const row of res.rows as Array<{ id: string; general_id: string; target_x: number; target_y: number }>) {
      await client.query('UPDATE generals SET x = $1, y = $2 WHERE id = $3', [
        row.target_x,
        row.target_y,
        row.general_id,
      ]);
      await client.query("UPDATE marches SET status = 'arrived' WHERE id = $1", [row.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 读取某世界所有进行中行军的当前插值位置（WS 推送用）；worldId 为 null 时读全部 */
export async function listActiveMarches(
  db: Db,
  worldId: string | null,
): Promise<Array<{ generalId: string; x: number; y: number }>> {
  if (!db) {
    return [];
  }
  const params: unknown[] = [];
  let where = "WHERE status = 'active'";
  if (worldId !== null) {
    where += ' AND world_id = $1';
    params.push(worldId);
  }
  const res = await db.query(
    `SELECT origin_x, origin_y, target_x, target_y, departed_at, arrives_at, general_id
       FROM marches ${where}`,
    params,
  );
  const now = Date.now();
  return (res.rows as Array<Record<string, unknown>>).map((row) => {
    const pos = marchPositionAt(
      {
        originX: row.origin_x as number,
        originY: row.origin_y as number,
        targetX: row.target_x as number,
        targetY: row.target_y as number,
        departedAt: new Date(row.departed_at as string),
        arrivesAt: new Date(row.arrives_at as string),
      },
      now,
    );
    return { generalId: row.general_id as string, ...pos };
  });
}
