/** 后端健康检查响应 */
export interface HealthResponse {
  status: 'ok';
  db: 'connected' | 'disconnected';
  uptime: number;
  timestamp: string;
}