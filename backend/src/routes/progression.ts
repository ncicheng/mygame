import { Router } from 'express';
import type { Db } from '../db.js';
import { bearerToken, route } from '../http.js';
import { generalLevelUp, generalStarUp, troopUnlock, weaponUpgrade } from '../progression.js';
import type { ProgressionResponse } from '@mygame/shared';

/** 组装养成路由；db 以参数注入，便于测试 */
export function createProgressionRouter(db: Db): Router {
  const router = Router();

  const post = (path: string, handler: (token: string, body: unknown) => Promise<ProgressionResponse>) => {
    router.post(
      path,
      route(async (req, res) => {
        const token = bearerToken(req.headers.authorization);
        if (!token) {
          res.status(401).json({ error: '未登录或会话已过期' });
          return;
        }
        const result = await handler(token, req.body);
        res.json(result);
      }),
    );
  };

  post('/level-up', (token, body) => generalLevelUp(db, token, body));
  post('/star-up', (token, body) => generalStarUp(db, token, body));
  post('/weapon-upgrade', (token, body) => weaponUpgrade(db, token, body));
  post('/troop-unlock', (token, body) => troopUnlock(db, token, body));

  return router;
}
