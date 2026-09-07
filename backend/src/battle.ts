import { randomUUID } from 'node:crypto';
import type { Queryable } from './actionPoints.js';
import { trySpendActionPoints } from './actionPoints.js';
import type { Db } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError } from './http.js';
import {
  ACTION_COSTS,
  LOSER_CASUALTY_RATE,
  WILDLAND_REFRESH_MS,
  WINNER_CASUALTY_RATE,
  generalSidePower,
  resolveCombat,
  shouldReleaseSkill,
  wildlandDrop,
  type BattleReport,
  type CombatResult,
  type CombatUnit,
  type CombatSideInput,
} from '@mygame/shared';

/** 战斗服务错误：携带 HTTP 状态码与可读信息 */
export class BattleError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'BattleError';
  }
}

/** 由字符串派生确定性种子：行军/战斗结果在离线结算时稳定可复现 */
function seedFromString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 按战损率应用一档兵的战损：更新或删除 army_units 行 */
async function applyUnitLosses(
  client: Queryable,
  generalId: string,
  army: CombatUnit[],
  rate: number,
): Promise<void> {
  for (const unit of army) {
    const loss = Math.floor(unit.count * rate);
    const remaining = unit.count - loss;
    if (remaining <= 0) {
      await client.query('DELETE FROM army_units WHERE general_id = $1 AND soldier_level = $2', [
        generalId,
        unit.soldierLevel,
      ]);
    } else {
      await client.query('UPDATE army_units SET count = $1 WHERE general_id = $2 AND soldier_level = $3', [
        remaining,
        generalId,
        unit.soldierLevel,
      ]);
    }
  }
}

/** 刷新已过期的野地：被攻破的野地经过刷新周期后恢复守军与掉落 */
export async function refreshWildlands(db: Db, worldId: string): Promise<void> {
  if (!db) {
    return;
  }
  await db.query(
    `UPDATE wildlands
        SET defeated_at = NULL, drop = GREATEST(1, round(strength / 10.0))
      WHERE world_id = $1 AND defeated_at IS NOT NULL AND defeated_at + ($2 * interval '1 millisecond') <= now()`,
    [worldId, WILDLAND_REFRESH_MS],
  );
}

/** 行军到达野地 → 触发并结算一场战斗实例。返回 true 表示已发生战斗（调用方跳过常规落位）。
 * 传入事务内客户端（Queryable），保证与行军落位在同一事务中原子生效。 */
export async function resolveArrivalBattle(
  client: Queryable,
  args: {
    marchId: string;
    worldId: string;
    generalId: string;
    userId: string;
    targetX: number;
    targetY: number;
  },
): Promise<boolean> {
  // 目标格有存活野地才触发战斗
  const wildRes = await client.query(
    `SELECT id, name, strength FROM wildlands
      WHERE world_id = $1 AND x = $2 AND y = $3 AND defeated_at IS NULL`,
    [args.worldId, args.targetX, args.targetY],
  );
  if (wildRes.rows.length === 0) {
    return false;
  }
  const wildland = wildRes.rows[0] as { id: string; name: string; strength: number };

  // 读取攻击方武将（等级/武器阶）与部队
  const genRes = await client.query(
    `SELECT g.level, g.weapon_id, w.tier AS weapon_tier
       FROM generals g
       LEFT JOIN weapons w ON w.id = g.weapon_id
      WHERE g.id = $1`,
    [args.generalId],
  );
  if (genRes.rows.length === 0) {
    return false;
  }
  const general = genRes.rows[0] as { level: number; weapon_tier: number | null };
  const armyRes = await client.query(
    'SELECT soldier_level, count FROM army_units WHERE general_id = $1',
    [args.generalId],
  );
  const army: CombatUnit[] = (armyRes.rows as Array<{ soldier_level: number; count: number }>).map((r) => ({
    soldierLevel: r.soldier_level,
    count: r.count,
  }));

  const attackerInput: CombatSideInput = {
    generalLevel: general.level,
    weaponTier: general.weapon_tier,
    army,
  };
  const attackerPower = generalSidePower(attackerInput);
  const attackerCount = army.reduce((sum, u) => sum + u.count, 0);
  const defenderPower = wildland.strength;
  const defenderCount = wildland.strength;

  const result: CombatResult = resolveCombat({
    attackerPower,
    defenderPower,
    attackerCount,
    defenderCount,
    seed: seedFromString(args.marchId),
    // 服务器权威决定技能是否自动释放（确定性规则），并随战斗写入战报与实例
    skillUsed: shouldReleaseSkill(attackerPower, defenderPower),
  });

  // 打野消耗行动点（行军已消耗出征点，此为战斗消耗；不足时仍照常结算）
  await trySpendActionPoints(client, args.userId, ACTION_COSTS.bandit).catch(() => false);

  const victory = result.attackerWon;
  const droppedRare = victory ? wildlandDrop(defenderPower) : 0;

  const battleId = randomUUID();
  const reportId = randomUUID();

  // 胜方轻损、败方重损：攻击方按胜负套用相应战损率
  const attackerLossRate = victory ? WINNER_CASUALTY_RATE : LOSER_CASUALTY_RATE;
  await applyUnitLosses(client, args.generalId, army, attackerLossRate);

  if (victory) {
    // 胜利：掉落稀有材料写入资源卡；野地被攻破进入刷新倒计时；部队留在野地格
    await client.query('UPDATE resources SET rare = rare + $1 WHERE user_id = $2', [droppedRare, args.userId]);
    await client.query('UPDATE wildlands SET defeated_at = now() WHERE id = $1', [wildland.id]);
    await client.query('UPDATE generals SET x = $1, y = $2 WHERE id = $3', [
      args.targetX,
      args.targetY,
      args.generalId,
    ]);
  } else {
    // 战败：武将重伤回城（武将不灭、不掉级），兵战损已落库
    const cityRes = await client.query(
      `SELECT x, y FROM cities WHERE world_id = $1 AND owner_user_id = $2 ORDER BY created_at LIMIT 1`,
      [args.worldId, args.userId],
    );
    const home = cityRes.rows[0] as { x: number; y: number } | undefined;
    if (home) {
      await client.query('UPDATE generals SET x = $1, y = $2 WHERE id = $3', [home.x, home.y, args.generalId]);
    }
  }
  await client.query("UPDATE marches SET status = 'arrived' WHERE id = $1", [args.marchId]);

  await client.query(
    `INSERT INTO battle_instances
       (id, world_id, attacker_general_id, attacker_user_id, defender_wildland_id,
        attacker_power, defender_power, winner, attacker_casualties, defender_casualties,
        dropped_rare, skill_used, log)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      battleId,
      args.worldId,
      args.generalId,
      args.userId,
      wildland.id,
      result.attacker.power,
      result.defender.power,
      victory ? 'attacker' : 'defender',
      result.attacker.casualties,
      result.defender.casualties,
      droppedRare,
      result.skillUsed,
      JSON.stringify(result),
    ],
  );
  await client.query(
    `INSERT INTO battle_reports
       (id, user_id, general_id, battle_instance_id, wildland_id, wildland_name,
        victory, attacker_casualties, defender_casualties, dropped_rare, log)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      reportId,
      args.userId,
      args.generalId,
      battleId,
      wildland.id,
      wildland.name,
      victory,
      result.attacker.casualties,
      result.defender.casualties,
      droppedRare,
      JSON.stringify(result),
    ],
  );

  return true;
}

/** 读取某用户最近的战报列表（战报卡展示用） */
export async function listReports(db: Db, token: string): Promise<BattleReport[]> {
  await ensureSchema(db);
  if (!db) {
    throw new BattleError(503, '服务暂不可用（未连接数据库）');
  }
  const sessionRes = await db.query('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (sessionRes.rows.length === 0) {
    throw new BattleError(401, '未登录或会话已过期');
  }
  const userId = sessionRes.rows[0].user_id as string;

  const res = await db.query(
    `SELECT r.id, r.general_id, g.name AS general_name, r.wildland_name,
            r.victory, r.attacker_casualties, r.defender_casualties, r.dropped_rare, r.log, r.created_at
       FROM battle_reports r
       JOIN generals g ON g.id = r.general_id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 20`,
    [userId],
  );
  return (res.rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    generalId: row.general_id as string,
    generalName: row.general_name as string,
    wildlandName: row.wildland_name as string,
    victory: row.victory as boolean,
    attackerCasualties: row.attacker_casualties as number,
    defenderCasualties: row.defender_casualties as number,
    droppedRare: row.dropped_rare as number,
    log: row.log as CombatResult,
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}
