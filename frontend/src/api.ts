import type {
  AuthResponse,
  BattleReportsResponse,
  LoginRequest,
  MarchRequest,
  MarchResponse,
  MeResponse,
  ProgressionResponse,
  RecruitRequest,
  RecruitResponse,
  RegisterRequest,
  UserProfile,
  WorldStateResponse,
} from '@mygame/shared';

// 生产环境（GitHub Pages）通过构建时注入 VITE_API_BASE_URL 指向后端地址；
// 开发环境由 Vite 代理 /api 到本地后端，留空即可。
// 防御式读取：非 Vite 运行时（如 node 单测）import.meta.env 可能未定义，收敛为空串（同源）。
export const API_BASE =
  (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? '';

/** 带状态码的 API 错误，message 为后端返回的可读错误 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
  }
  return body as T;
}

/** 注册：成功后返回会话 token 与用户档案 */
export function apiRegister(username: string, password: string): Promise<AuthResponse> {
  const payload: RegisterRequest = { username, password };
  return request<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
}

/** 登录：成功后返回会话 token 与用户档案 */
export function apiLogin(username: string, password: string): Promise<AuthResponse> {
  const payload: LoginRequest = { username, password };
  return request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
}

/** 按会话 token 获取当前用户档案 */
export async function apiMe(token: string): Promise<UserProfile> {
  const res = await request<MeResponse>('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  return res.user;
}

/** 登出：使会话 token 失效 */
export async function apiLogout(token: string): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}

/** 拉取当前登录用户的世界状态（登录用户视角） */
export async function apiWorld(token: string): Promise<WorldStateResponse> {
  return request('/api/world', { headers: { Authorization: `Bearer ${token}` } });
}

/** 招募：消耗基础资源与行动点，兵加入部队；返回更新后的档案与行动点 */
export function apiRecruit(token: string, req: RecruitRequest): Promise<RecruitResponse> {
  return request<RecruitResponse>('/api/recruit', {
    method: 'POST',
    body: JSON.stringify(req),
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 发布行军命令：消耗行动点，为部队下达行军到目标格 */
export function apiMarch(token: string, req: MarchRequest): Promise<MarchResponse> {
  return request<MarchResponse>('/api/march', {
    method: 'POST',
    body: JSON.stringify(req),
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 取消行军：部队返回起点 */
export function apiCancelMarch(token: string, marchId: string): Promise<MarchResponse> {
  return request<MarchResponse>('/api/march/cancel', {
    method: 'POST',
    body: JSON.stringify({ marchId }),
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 拉取当前用户最近的战报列表（战报卡展示） */
export function apiBattleReports(token: string): Promise<BattleReportsResponse> {
  return request<BattleReportsResponse>('/api/battle/reports', { headers: { Authorization: `Bearer ${token}` } });
}

/** 武将升级：等级 +1，消耗稀有材料；返回更新后的档案 */
export function apiGeneralLevelUp(token: string, generalId: string): Promise<ProgressionResponse> {
  return request<ProgressionResponse>('/api/progression/level-up', {
    method: 'POST',
    body: JSON.stringify({ generalId }),
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 武将升星：星级 +1，消耗稀有材料；返回更新后的档案 */
export function apiGeneralStarUp(token: string, generalId: string): Promise<ProgressionResponse> {
  return request<ProgressionResponse>('/api/progression/star-up', {
    method: 'POST',
    body: JSON.stringify({ generalId }),
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 武器升阶：武将武器阶 +1，消耗稀有材料；返回更新后的档案 */
export function apiWeaponUpgrade(token: string, generalId: string): Promise<ProgressionResponse> {
  return request<ProgressionResponse>('/api/progression/weapon-upgrade', {
    method: 'POST',
    body: JSON.stringify({ generalId }),
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 兵种解锁：逐级解锁更高阶兵种，消耗稀有材料；返回更新后的档案 */
export function apiTroopUnlock(token: string, troopLevel: number): Promise<ProgressionResponse> {
  return request<ProgressionResponse>('/api/progression/troop-unlock', {
    method: 'POST',
    body: JSON.stringify({ troopLevel }),
    headers: { Authorization: `Bearer ${token}` },
  });
}