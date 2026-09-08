import { Router } from 'express';
import type { Db } from '../db.js';
import { bearerToken, route } from '../http.js';
import { cancelMarch, createMarch } from '../march.js';
import type { MarchResponse } from '@mygame/shared';

/** 组装行军路由；db 以参数注入，便于测试 */
export function createMarchRouter(db: Db): Router {
  const router = Router();

  router.post(
    '/',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      const body: MarchResponse = await createMarch(db, token, req.body);
      res.json(body);
    }),
  );

  router.post(
    '/cancel',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      const marchId = (req.body as Record<string, unknown> | undefined)?.marchId;
      if (typeof marchId !== 'string' || !marchId) {
        res.status(400).json({ error: '请指定要取消的行军' });
        return;
      }
      const body: MarchResponse = await cancelMarch(db, token, marchId);
      res.json(body);
    }),
  );

  return router;
}
