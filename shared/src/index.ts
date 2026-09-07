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

export { TROOP_CATALOG, getTroopType } from './troops.js';
export type { TroopType } from './troops.js';
