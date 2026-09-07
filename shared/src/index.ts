import type { CombatResult } from './combat.js';

/** 后端健康检查响应 */
export interface HealthResponse {
  status: 'ok';
  db: 'connected' | 'disconnected';
  uptime: number;
  timestamp: string;
}

/** 玩家资源：粮草/铁材/稀有材料/金币 */
export interface Resources {
  food: number;
  iron: number;
  rare: number;
  gold: number;
}

/** 武器：按 1-20 阶分档，可装备物品 */
export interface Weapon {
  id: string;
  name: string;
  tier: number;
}

/** 部队中的兵：按 1-15 级分档，消耗品 */
export interface Soldier {
  soldierType: string;
  soldierLevel: number;
  count: number;
}

/** 武将：独立英雄单位，率领部队；可装备任意阶武器 */
export interface General {
  id: string;
  name: string;
  level: number;
  weapon: Weapon | null;
  army: Soldier[];
}

/** 用户账号档案（含自己的武将与资源） */
export interface UserProfile {
  id: string;
  username: string;
  registeredAt: string;
  resources: Resources;
  generals: General[];
}

/** 注册请求 */
export interface RegisterRequest {
  username: string;
  password: string;
}

/** 登录请求 */
export interface LoginRequest {
  username: string;
  password: string;
}

/** 注册/登录成功响应 */
export interface AuthResponse {
  token: string;
  user: UserProfile;
}

/** 当前登录用户响应 */
export interface MeResponse {
  user: UserProfile;
}

/** 通用错误响应 */
export interface ErrorResponse {
  error: string;
}

/** 地形代码：g=平原 f=林地 m=山地 w=水域 */
export type Terrain = 'g' | 'f' | 'm' | 'w';

/** 归属方：me=我方 enemy=敌方 */
export type Side = 'me' | 'enemy';

/** 大地图信息（持久世界，规模可配） */
export interface WorldInfo {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** 城池：地图上的战略据点 */
export interface WorldCity {
  id: string;
  name: string;
  x: number;
  y: number;
  side: Side;
}

/** 野地（山贼营地）：可被攻打的目标 */
export interface WorldWildland {
  id: string;
  name: string;
  x: number;
  y: number;
  strength: number;
}

/** 部队：武将及其率领的兵在地图上的位置 */
export interface WorldArmy {
  id: string;
  generalName: string;
  x: number;
  y: number;
  side: Side;
  troopCount: number;
  /** 进行中的行军；无行军时为 null */
  march: WorldMarch | null;
}

/** 行军状态：行进中 / 已到达 / 已取消 */
export type MarchStatus = 'active' | 'arrived' | 'cancelled';

/** 行军命令：部队从起点行军到目标格，按服务器时钟插值位置 */
export interface WorldMarch {
  id: string;
  generalId: string;
  originX: number;
  originY: number;
  targetX: number;
  targetY: number;
  departedAt: string;
  arrivesAt: string;
  status: MarchStatus;
}

/** 行动点：当前/上限 + 恢复信息 */
export interface ActionPoints {
  current: number;
  max: number;
  recoverMs: number;
  nextRecoveryAt: string | null;
}

/** 世界状态响应（登录用户视角） */
export interface WorldStateResponse {
  world: WorldInfo;
  tiles: string[];
  cities: WorldCity[];
  wildlands: WorldWildland[];
  armies: WorldArmy[];
  actionPoints: ActionPoints;
}

/** 行动点上限 */
export const AP_MAX = 5;

/** 行动点恢复周期：每 10 分钟恢复 1 点 */
export const AP_RECOVER_MS = 10 * 60 * 1000;

/** 行动点消耗规则（出征/招募/打野/攻城），招募 Task 4 起使用 */
export const ACTION_COSTS = { march: 1, recruit: 1, bandit: 2, siege: 3 } as const;

/** 打野一次完整消耗：出征（行军）1 + 战斗 2 = 3 行动点。前端打野按钮据此置灰，
 * 避免行动点在 2~3 之间时出征成功但战斗扣点失败（best-effort 仍结算）的断头体验。 */
export const BANDIT_TOTAL_AP = ACTION_COSTS.march + ACTION_COSTS.bandit;

/** 行军速度：每走过一格耗时（毫秒）。20×14 小地图下 1.5s/格，数秒可达相邻目标 */
export const MARCH_TILE_MS = 1500;

/** 行军请求：为指定部队（武将）下达行军命令到目标格 */
export interface MarchRequest {
  generalId: string;
  targetX: number;
  targetY: number;
}

/** 行军响应：创建的行军命令与最新行动点 */
export interface MarchResponse {
  march: WorldMarch;
  actionPoints: ActionPoints;
}

/** 招募请求：为指定武将招募指定等级的兵，数量为正整数 */
export interface RecruitRequest {
  generalId: string;
  soldierLevel: number;
  count: number;
}

/** 招募响应：更新后的用户档案与行动点（部队编成卡/资源卡实时刷新用） */
export interface RecruitResponse {
  user: UserProfile;
  actionPoints: ActionPoints;
}

/** 世界生成配置 */
export interface WorldConfig {
  name: string;
  width: number;
  height: number;
  seed: number;
  enemyCities: number;
  wildlands: number;
}

/** 战报：一场打野战斗的结算结果，写入右卡片栏战报卡 */
export interface BattleReport {
  id: string;
  generalId: string;
  generalName: string;
  wildlandName: string;
  victory: boolean;
  attackerCasualties: number;
  defenderCasualties: number;
  droppedRare: number;
  /** 战斗结算完整日志（前端播放展示用） */
  log: CombatResult;
  createdAt: string;
}

/** 战报列表响应 */
export interface BattleReportsResponse {
  reports: BattleReport[];
}

export { TROOP_CATALOG, getTroopType } from './troops.js';
export type { TroopType } from './troops.js';

export {
  GENERAL_BONUS_PER_LEVEL,
  WEAPON_BONUS_PER_TIER,
  WIN_PROB_SLOPE,
  WINNER_CASUALTY_RATE,
  LOSER_CASUALTY_RATE,
  BATTLE_ROUNDS,
  SKILL_POWER_BOOST,
  WILDLAND_REFRESH_MS,
  mulberry32,
  generalMultiplier,
  weaponBonus,
  armyPower,
  generalSidePower,
  winProbability,
  resolveCombat,
  shouldReleaseSkill,
  wildlandDrop,
} from './combat.js';
export type {
  CombatUnit,
  CombatSideInput,
  CombatantStats,
  CombatRound,
  CombatResult,
} from './combat.js';
