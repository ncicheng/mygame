import { Router } from 'express';
import type { Db } from '../db.js';
import { bearerToken, route } from '../http.js';
import { recruit } from '../recruit.js';
import type { RecruitResponse } from '@mygame/shared';

/** 组装招募路由；db 以参数注入，便于测试 */
export function createRecruitRouter(db: Db): Router {
  const router = Router();

  router.post(
    '/',
    route(async (req, res) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        res.status(401).json({ error: '未登录或会话已过期' });
        return;
      }
      const result = await recruit(db, token, req.body);
      const body: RecruitResponse = result;
      res.json(body);
    }),
  );

  return router;
}