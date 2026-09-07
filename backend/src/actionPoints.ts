import type { Db } from './db.js';
import { HttpError } from './http.js';
import { AP_MAX, AP_RECOVER_MS, type ActionPoints } from '@mygame/shared';

/** 行动点服务错误：携带 HTTP 状态码与可读信息 */
export class ActionPointError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'ActionPointError';
  }
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

/** 读取并推进玩家行动点（按恢复周期补点），返回给前端展示的结构 */
export async function getActionPoints(db: Db, userId: string): Promise<ActionPoints> {
  if (!db) {
    throw new ActionPointError(503, '服务暂不可用（未连接数据库）');
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
    throw new ActionPointError(503, '服务暂不可用（未连接数据库）');
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
