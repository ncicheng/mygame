import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { STARTER_ARMY, STARTER_WEAPON, STARTER_RESOURCES } from '../src/starter.js';

// 单元测试：不依赖数据库，仅验证输入校验、无库时的行为与初始数据定义

test('POST /api/auth/register 缺少用户名时返回 400', async () => {
  const app = createApp({ db: null });
  const res = await request(app).post('/api/auth/register').send({ password: 'secret123' });

  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test('POST /api/auth/register 缺少密码时返回 400', async () => {
  const app = createApp({ db: null });
  const res = await request(app).post('/api/auth/register').send({ username: 'player1' });

  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test('POST /api/auth/login 缺少用户名时返回 400', async () => {
  const app = createApp({ db: null });
  const res = await request(app).post('/api/auth/login').send({ password: 'secret123' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/register 未连接数据库时返回 503', async () => {
  const app = createApp({ db: null });
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'player1', password: 'secret123' });

  assert.equal(res.status, 503);
});

test('GET /api/auth/me 未携带 token 时返回 401', async () => {
  const app = createApp({ db: null });
  const res = await request(app).get('/api/auth/me');

  assert.equal(res.status, 401);
});

test('POST /api/auth/logout 未携带 token 时返回 401', async () => {
  const app = createApp({ db: null });
  const res = await request(app).post('/api/auth/logout');

  assert.equal(res.status, 401);
});

test('初始武将：Lv.1 乡勇部队（乡勇 1 级 × 100）+ 1 阶木矛', () => {
  assert.equal(STARTER_ARMY.length, 1);
  assert.equal(STARTER_ARMY[0].soldierType, '乡勇');
  assert.equal(STARTER_ARMY[0].soldierLevel, 1);
  assert.equal(STARTER_ARMY[0].count, 100);
  assert.equal(STARTER_WEAPON.name, '木矛');
  assert.equal(STARTER_WEAPON.tier, 1);
});

test('初始资源含粮草/铁材/稀有材料/金币四项且不小于 0', () => {
  for (const key of ['food', 'iron', 'rare', 'gold'] as const) {
    assert.equal(typeof STARTER_RESOURCES[key], 'number');
    assert.ok(STARTER_RESOURCES[key] >= 0, `${key} 初始量应为非负数`);
  }
});