import { Router } from 'express';
import type { Db } from '../db.js';
import { bearerToken, route } from '../http.js';
import { fetchWorldState } from '../world.js';

/** 组装世界路由；db 以参数注入，便于测试 */
export function createWorldRouter(db: Db): Router {
  const router = Router();

  router.get(
    '/',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      res.json(await fetchWorldState(db, token));
    }),
  );

  return router;
}