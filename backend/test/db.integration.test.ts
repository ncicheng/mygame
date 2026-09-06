import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDb, checkDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// 未设置 DATABASE_URL 时跳过；本测试必须连真实本地 Postgres 才算通过
const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl
  ? false
  : 'DATABASE_URL 未设置。安装并启动本地 Postgres 后设置 DATABASE_URL（如 postgres://localhost:5432/mygame_test）再运行：npm run test:integration';

test('createDb 在 DATABASE_URL 未设置时返回 null', () => {
  assert.equal(createDb(undefined), null);
});

test(
  '真实 Postgres 连接：SELECT 1 成功',
  { skip },
  async () => {
    const db = createDb(databaseUrl);
    assert.ok(db, '设置了 DATABASE_URL 后应创建连接池');
    try {
      assert.equal(await checkDb(db), true);
    } finally {
      await db.end();
    }
  },
);

test(
  'GET /api/health 在真实 Postgres 连接下返回 db=connected',
  { skip },
  async () => {
    const db = createDb(databaseUrl);
    assert.ok(db);
    try {
      const app = createApp({ db });
      const res = await request(app).get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.db, 'connected');
    } finally {
      await db.end();
    }
  },
);