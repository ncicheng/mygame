import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError } from './http.js';
import { AP_MAX, AP_RECOVER_MS } from '@mygame/shared';
import type {
  ActionPoints,
  Side,
  Terrain,
  WorldArmy,
  WorldCity,
  WorldInfo,
  WorldStateResponse,
  WorldWildland,
} from '@mygame/shared';

/** 世界配置：MVP 用 20×14 小地图验证，规模可配到数百×数百 */
export const WORLD_CONFIG = {
  name: process.env.WORLD_NAME ?? '乱世·初平',
  width: Number(process.env.WORLD_WIDTH ?? 20),
  height: Number(process.env.WORLD_HEIGHT ?? 14),
  seed: Number(process.env.WORLD_SEED ?? 178436),
  enemyCities: 2,
  wildlands: 3,
} as const;

export type WorldConfig = typeof WORLD_CONFIG;

/** 预置敌方城池与野地的名称 */
const ENEMY_CITY_NAMES = ['黑风寨', '赤炎堡', '铁鹰关'];
const WILDLAND_NAMES = ['山贼营地', '流寇据点', '山贼营地'];

/** 世界服务错误：携带 HTTP 状态码与可读信息 */
export class WorldError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'WorldError';
  }
}

/** 可复现的伪随机数发生器（种子决定世界地形，保证持久一致） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从随机中心长成一块带抖动边界的有机地形团 */
function growBlob(
  grid: string[][],
  width: number,
  height: number,
  terrain: Terrain,
  radius: number,
  rng: () => number,
): void {
  const cx = Math.floor(rng() * width);
  const cy = Math.floor(rng() * height);
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const jitter = 0.55 + rng() * 0.95;
      if (dist * jitter <= radius) {
        grid[y][x] = terrain;
      }
    }
  }
}

/** 生成地形网格：每行一个字符串，字符为地形代码 */
export function generateTerrain(width: number, height: number, seed: number): string[] {
  const grid: string[][] = Array.from({ length: height }, () => Array<string>(width).fill('g'));
  const rng = mulberry32(seed);
  const maxDim = Math.max(width, height);
  // 先水（大湖）后林、山，后续图层盖住平原
  growBlob(grid, width, height, 'w', Math.floor(maxDim * 0.3), rng);
  growBlob(grid, width, height, 'w', Math.floor(maxDim * 0.2), rng);
  growBlob(grid, width, height, 'f', Math.floor(maxDim * 0.22), rng);
  growBlob(grid, width, height, 'f', Math.floor(maxDim * 0.18), rng);
  growBlob(grid, width, height, 'm', Math.floor(maxDim * 0.16), rng);
  growBlob(grid, width, height, 'm', Math.floor(maxDim * 0.14), rng);
  return grid.map((row) => row.join(''));
}

/** 从中心按方形环向外螺旋搜索，返回首个满足 isFree 的格子 */
export function findStartTile(
  width: number,
  height: number,
  isFree: (x: number, y: number) => boolean,
): { x: number; y: number } | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const maxRing = Math.max(cx, width - 1 - cx, cy, height - 1 - cy);
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
          continue;
        }
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) {
          continue;
        }
        if (isFree(x, y)) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

/** 行动点计算的中间结果 */
export interface ApComputation {
  current: number;
  lastRecoveredAt: Date;
  nextRecoveryAt: Date | null;
}

/** 计算行动点：每满一个恢复周期补 1 点，最多封顶到上限 */
export function computeActionPoints(
  current: number,
  max: number,
  lastRecoveredAt: Date,
  now: Date,
  recoverMs: number,
): ApComputation {
  const elapsed = now.getTime() - lastRecoveredAt.getTime();
  const periods = Math.max(0, Math.floor(elapsed / recoverMs));
  const newCurrent = Math.min(max, current + periods);
  const newLast = periods > 0 ? new Date(lastRecoveredAt.getTime() + periods * recoverMs) : lastRecoveredAt;
  const nextRecoveryAt = newCurrent >= max ? null : new Date(newLast.getTime() + recoverMs);
  return { current: newCurrent, lastRecoveredAt: newLast, nextRecoveryAt };
}

/** 确保默认世界存在：不存在则生成地形并预置敌方城池与野地，返回世界 id */
export async function ensureDefaultWorld(db: Db, config: WorldConfig = WORLD_CONFIG): Promise<string> {
  await ensureSchema(db);
  if (!db) {
    throw new WorldError(503, '服务暂不可用（未连接数据库）');
  }

  const existing = await db.query('SELECT id FROM worlds ORDER BY created_at LIMIT 1');
  if (existing.rows.length > 0) {
    return existing.rows[0].id as string;
  }

  const worldId = randomUUID();
  const rows = generateTerrain(config.width, config.height, config.seed);

  // 预置敌方城池与野地：落位互不重叠，且都在平原上
  const occupied = new Set<string>();
  const seedCities: Array<{ x: number; y: number; name: string }> = [];
  for (let i = 0; i < config.enemyCities; i++) {
    const t = findStartTile(config.width, config.height, (x, y) => rows[y]?.[x] === 'g' && !occupied.has(`${x},${y}`));
    if (!t) {
      break;
    }
    occupied.add(`${t.x},${t.y}`);
    seedCities.push({ ...t, name: ENEMY_CITY_NAMES[i] ?? '敌方城' });
  }
  const seedWildlands: Array<{ x: number; y: number; name: string }> = [];
  for (let i = 0; i < config.wildlands; i++) {
    const t = findStartTile(config.width, config.height, (x, y) => rows[y]?.[x] === 'g' && !occupied.has(`${x},${y}`));
    if (!t) {
      break;
    }
    occupied.add(`${t.x},${t.y}`);
    seedWildlands.push({ ...t, name: WILDLAND_NAMES[i] ?? '山贼营地' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO worlds (id, name, width, height, seed) VALUES ($1, $2, $3, $4, $5)', [
      worldId,
      config.name,
      config.width,
      config.height,
      config.seed,
    ]);

    // 分块插入地形格（规模可配到数百×数百，避免单条 SQL 参数超限）
    const tileValues: string[] = [];
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        tileValues.push(worldId, String(x), String(y), rows[y][x]);
      }
    }
    for (let i = 0; i < tileValues.length; i += 4000) {
      const chunk = tileValues.slice(i, i + 4000);
      const placeholders: string[] = [];
      for (let j = 0; j < chunk.length; j += 4) {
        placeholders.push(`($${j + 1}, $${j + 2}, $${j + 3}, $${j + 4})`);
      }
      await client.query(`INSERT INTO world_tiles (world_id, x, y, terrain) VALUES ${placeholders.join(',')}`, chunk);
    }

    for (const c of seedCities) {
      await client.query(
        'INSERT INTO cities (id, world_id, x, y, name, owner_user_id) VALUES ($1, $2, $3, $4, $5, NULL)',
        [randomUUID(), worldId, c.x, c.y, c.name],
      );
    }
    for (const wl of seedWildlands) {
      await client.query(
        'INSERT INTO wildlands (id, world_id, x, y, name, strength) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), worldId, wl.x, wl.y, wl.name, 100],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return worldId;
}

/** 为玩家在世界中寻找空闲平原格（放置主城与初始部队） */
export async function findPlayerStartTile(db: Db, worldId: string): Promise<{ x: number; y: number }> {
  if (!db) {
    throw new WorldError(503, '服务暂不可用（未连接数据库）');
  }
  const worldRes = await db.query('SELECT width, height FROM worlds WHERE id = $1', [worldId]);
  if (worldRes.rows.length === 0) {
    throw new WorldError(500, '世界不存在');
  }
  const width = worldRes.rows[0].width as number;
  const height = worldRes.rows[0].height as number;

  const tileRes = await db.query('SELECT x, y, terrain FROM world_tiles WHERE world_id = $1', [worldId]);
  const terrain = new Map<string, Terrain>();
  for (const row of tileRes.rows) {
    terrain.set(`${row.x},${row.y}`, row.terrain as Terrain);
  }

  const occRes = await db.query(
    'SELECT x, y FROM cities WHERE world_id = $1 UNION ALL SELECT x, y FROM wildlands WHERE world_id = $1',
    [worldId],
  );
  const occupied = new Set<string>();
  for (const row of occRes.rows) {
    occupied.add(`${row.x},${row.y}`);
  }

  const tile = findStartTile(width, height, (x, y) => terrain.get(`${x},${y}`) === 'g' && !occupied.has(`${x},${y}`));
  if (!tile) {
    throw new WorldError(500, '世界已无空闲平原格，无法安置玩家');
  }
  return tile;
}

/** 读取并推进玩家行动点（按恢复周期补点），返回给前端展示的结构 */
export async function getActionPoints(db: Db, userId: string): Promise<ActionPoints> {
  if (!db) {
    throw new WorldError(503, '服务暂不可用（未连接数据库）');
  }
  const res = await db.query('SELECT current, max, last_recovered_at FROM action_points WHERE user_id = $1', [userId]);
  if (res.rows.length === 0) {
    return { current: AP_MAX, max: AP_MAX, recoverMs: AP_RECOVER_MS, nextRecoveryAt: null };
  }
  const row = res.rows[0];
  const computed = computeActionPoints(
    row.current as number,
    row.max as number,
    new Date(row.last_recovered_at as string),
    new Date(),
    AP_RECOVER_MS,
  );
  if (computed.lastRecoveredAt.getTime() !== new Date(row.last_recovered_at as string).getTime()) {
    await db.query('UPDATE action_points SET current = $1, last_recovered_at = $2 WHERE user_id = $3', [
      computed.current,
      computed.lastRecoveredAt,
      userId,
    ]);
  }
  return {
    current: computed.current,
    max: row.max as number,
    recoverMs: AP_RECOVER_MS,
    nextRecoveryAt: computed.nextRecoveryAt ? computed.nextRecoveryAt.toISOString() : null,
  };
}

/** 行动点消耗：足额则扣减并返回 true，不足返回 false（Task 4+ 调用） */
export async function trySpendActionPoints(db: Db, userId: string, cost: number): Promise<boolean> {
  if (!db) {
    throw new WorldError(503, '服务暂不可用（未连接数据库）');
  }
  const res = await db.query('SELECT current, max, last_recovered_at FROM action_points WHERE user_id = $1', [userId]);
  if (res.rows.length === 0) {
    return false;
  }
  const row = res.rows[0];
  const computed = computeActionPoints(
    row.current as number,
    row.max as number,
    new Date(row.last_recovered_at as string),
    new Date(),
    AP_RECOVER_MS,
  );
  if (computed.current < cost) {
    return false;
  }
  await db.query('UPDATE action_points SET current = $1, last_recovered_at = $2 WHERE user_id = $3', [
    computed.current - cost,
    computed.lastRecoveredAt,
    userId,
  ]);
  return true;
}

/** 组装登录用户视角的世界状态 */
export async function fetchWorldState(db: Db, token: string): Promise<WorldStateResponse> {
  await ensureSchema(db);
  if (!db) {
    throw new WorldError(503, '服务暂不可用（未连接数据库）');
  }

  const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (sessionRes.rows.length === 0) {
    throw new WorldError(401, '未登录或会话已过期');
  }
  const userId = sessionRes.rows[0].user_id as string;

  // 玩家所在世界 = 其武将所在世界；没有武将时兜底到默认世界
  const genRes = await db.query('SELECT world_id FROM generals WHERE user_id = $1 LIMIT 1', [userId]);
  const worldId = (genRes.rows[0]?.world_id as string | undefined) ?? (await ensureDefaultWorld(db));

  const worldRes = await db.query('SELECT id, name, width, height FROM worlds WHERE id = $1', [worldId]);
  if (worldRes.rows.length === 0) {
    throw new WorldError(500, '世界不存在');
  }
  const worldRow = worldRes.rows[0];
  const width = worldRow.width as number;
  const height = worldRow.height as number;

  // 地形：按行组织为字符串数组（紧凑传输，几百×几百格仍可控）
  const tileRes = await db.query('SELECT x, y, terrain FROM world_tiles WHERE world_id = $1 ORDER BY y, x', [worldId]);
  const rowBuffer: string[] = Array(height).fill('');
  for (const row of tileRes.rows) {
    rowBuffer[row.y as number] += row.terrain as string;
  }
  const tiles = rowBuffer.map((row) => row.padEnd(width, 'g'));

  const cityRes = await db.query(
    'SELECT id, name, x, y, owner_user_id FROM cities WHERE world_id = $1 ORDER BY created_at',
    [worldId],
  );
  const cities: WorldCity[] = cityRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    x: r.x as number,
    y: r.y as number,
    side: (r.owner_user_id === userId ? 'me' : 'enemy') as Side,
  }));

  const wildRes = await db.query(
    'SELECT id, name, x, y, strength FROM wildlands WHERE world_id = $1 ORDER BY created_at',
    [worldId],
  );
  const wildlands: WorldWildland[] = wildRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    x: r.x as number,
    y: r.y as number,
    strength: r.strength as number,
  }));

  const armyRes = await db.query(
    `SELECT g.id, g.user_id, g.name, g.x, g.y, COALESCE(SUM(a.count), 0) AS troop_count
       FROM generals g
       LEFT JOIN army_units a ON a.general_id = g.id
      WHERE g.world_id = $1
      GROUP BY g.id
      ORDER BY g.created_at`,
    [worldId],
  );
  const armies: WorldArmy[] = armyRes.rows.map((r) => ({
    id: r.id as string,
    generalName: r.name as string,
    x: r.x as number,
    y: r.y as number,
    side: (r.user_id === userId ? 'me' : 'enemy') as Side,
    troopCount: Number(r.troop_count),
  }));

  const actionPoints = await getActionPoints(db, userId);

  return {
    world: {
      id: worldRow.id as string,
      name: worldRow.name as string,
      width,
      height,
    } satisfies WorldInfo,
    tiles,
    cities,
    wildlands,
    armies,
    actionPoints,
  };
}