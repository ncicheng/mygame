import { Router } from 'express';
import type { Db } from '../db.js';
import { bearerToken, route } from '../http.js';
import { listReports } from '../battle.js';
import type { BattleReportsResponse } from '@mygame/shared';

/** 组装战斗路由；db 以参数注入，便于测试 */
export function createBattleRouter(db: Db): Router {
  const router = Router();

  router.get(
    '/reports',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      const body: BattleReportsResponse = { reports: await listReports(db, token) };
      res.json(body);
    }),
  );

  return router;
}
