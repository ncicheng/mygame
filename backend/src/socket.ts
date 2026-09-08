import type { Server, Socket } from 'socket.io';
import type { Db } from './db.js';
import { finalizeArrivedMarches, listActiveMarches } from './march.js';
import { ensureDefaultWorld } from './world.js';

/** 世界房间前缀：每个已认证 socket 加入其所在世界的房间，推送只发往该房间 */
export const WORLD_ROOM_PREFIX = 'world:';

export interface SocketRuntime {
  /** 当前有已连接 socket 的世界 id 集合（世界时钟只向这些世界推送） */
  activeWorlds: Set<string>;
  /** 停止世界时钟（测试清理用） */
  stop(): void;
}

/** 各世界在线的 socket 计数，用于断开时判断是否还有人在线 */
type WorldCounts = Map<string, number>;

/** 依据 socket 认证 token 解析其所在世界并加入房间；未通过认证返回 false（由调用方断开）。 */
async function joinWorldRoom(
  socket: Socket,
  db: Db,
  activeWorlds: Set<string>,
  worldCounts: WorldCounts,
): Promise<boolean> {
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (!db || typeof token !== 'string' || !token) {
    return false;
  }
  try {
    const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
    if (sessionRes.rows.length === 0) {
      return false;
    }
    const userId = sessionRes.rows[0].user_id as string;
    // 玩家所在世界 = 其武将所在世界；没有武将时兜底到默认世界（与 /api/world 一致）
    const genRes = await db.query('SELECT world_id FROM generals WHERE user_id = $1 LIMIT 1', [userId]);
    const worldId = (genRes.rows[0]?.world_id as string | undefined) ?? (await ensureDefaultWorld(db));

    const room = WORLD_ROOM_PREFIX + worldId;
    await socket.join(room);
    activeWorlds.add(worldId);
    worldCounts.set(worldId, (worldCounts.get(worldId) ?? 0) + 1);
    // 断开后若该世界已无其他在线 socket，从推送集合移除
    socket.on('disconnect', () => {
      const n = (worldCounts.get(worldId) ?? 1) - 1;
      if (n <= 0) {
        worldCounts.delete(worldId);
        activeWorlds.delete(worldId);
      } else {
        worldCounts.set(worldId, n);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** 挂载 socket 认证与按世界推送的世界时钟；返回运行句柄便于测试清理。 */
export function setupSocket(io: Server, db: Db, tickMs = 1000): SocketRuntime {
  const activeWorlds = new Set<string>();
  const worldCounts: WorldCounts = new Map();

  io.on('connection', (socket) => {
    void joinWorldRoom(socket, db, activeWorlds, worldCounts).then((ok) => {
      if (!ok) {
        socket.disconnect(true);
      }
    });
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  if (db) {
    timer = setInterval(async () => {
      try {
        await finalizeArrivedMarches(db, null);
        // 只向有在线 socket 的世界推送该世界的行军位置，避免跨世界泄漏部队位置
        for (const worldId of activeWorlds) {
          const updates = await listActiveMarches(db, worldId);
          if (updates.length > 0) {
            io.to(WORLD_ROOM_PREFIX + worldId).emit('march:update', updates);
          }
        }
      } catch (err) {
        console.error('[world-clock] 推进行军位置失败：', err);
      }
    }, tickMs);
  }

  return {
    activeWorlds,
    stop: () => {
      if (timer) {
        clearInterval(timer);
      }
    },
  };
}
