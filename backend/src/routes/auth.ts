import { Router } from 'express';
import type { Db } from '../db.js';
import { getMe, login, logout, register } from '../auth.js';
import { bearerToken, route } from '../http.js';
import type { AuthResponse, MeResponse } from '@mygame/shared';

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