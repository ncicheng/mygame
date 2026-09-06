import { Router, type Request, type Response } from 'express';
import type { Db } from '../db.js';
import { AuthError, getMe, login, logout, register } from '../auth.js';
import type { AuthResponse, MeResponse } from '@mygame/shared';

/** 从请求头解析 Bearer token；缺失或格式错误返回 null */
function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}

/** 包装异步处理器：统一把 AuthError 映射为 HTTP 状态码，其余为 500 */
function route(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
      } else {
        console.error('[auth] 未预期错误：', err);
        res.status(500).json({ error: '服务器内部错误' });
      }
    }
  };
}

/** 组装认证路由；db 以参数注入，便于测试 */
export function createAuthRouter(db: Db): Router {
  const router = Router();

  router.post(
    '/register',
    route(async (req, res) => {
      const { token, user } = await register(db, req.body);
      const body: AuthResponse = { token, user };
      res.status(201).json(body);
    }),
  );

  router.post(
    '/login',
    route(async (req, res) => {
      const { token, user } = await login(db, req.body);
      const body: AuthResponse = { token, user };
      res.json(body);
    }),
  );

  router.post(
    '/logout',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      await logout(db, token);
      res.status(200).json({ ok: true });
    }),
  );

  router.get(
    '/me',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      const user = await getMe(db, token);
      const body: MeResponse = { user };
      res.json(body);
    }),
  );

  return router;
}