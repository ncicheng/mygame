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