import express from 'express';
import cors from 'cors';
import type { Db } from './db.js';
import { checkDb } from './db.js';
import { createAuthRouter } from './routes/auth.js';
import { createMarchRouter } from './routes/march.js';
import { createRecruitRouter } from './routes/recruit.js';
import { createWorldRouter } from './routes/world.js';
import { createBattleRouter } from './routes/battle.js';
import type { HealthResponse } from '@mygame/shared';

export interface AppOptions {
  db: Db;
}

/** 组装 Express 应用；db 以参数注入，便于测试 */
export function createApp({ db }: AppOptions): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/recruit', createRecruitRouter(db));
  app.use('/api/world', createWorldRouter(db));
  app.use('/api/march', createMarchRouter(db));
  app.use('/api/battle', createBattleRouter(db));

  app.get('/api/health', async (_req, res) => {
    const dbConnected = await checkDb(db);
    const body: HealthResponse = {
      status: 'ok',
      db: dbConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
    res.json(body);
  });

  return app;
}