import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ACTION_COSTS, AP_MAX, getTroopType, type UserProfile } from '@mygame/shared';

// 集成测试：必须连真实本地 Postgres 才算通过（run-integration.mjs 用 embedded-postgres 提供）
const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl
  ? false
  : 'DATABASE_URL 未设置。运行 npm run test:integration（embedded-postgres 自动提供真实 Postgres）。';

const db = createDb(databaseUrl);
const app = createApp({ db: databaseUrl ? db : null });

after(() => {
  void db?.end();
});

/** 生成不超 32 字且跨测试唯一的用户名 */
function uniqueUsername(): string {
  return `u${randomUUID().slice(0, 8)}`;
}

async function register(username: string, password: string) {
  return request(app).post('/api/auth/register').send({ username, password });
}

function postRecruit(token: string, body: Record<string, unknown>) {
  return request(app).post('/api/recruit').set('Authorization', `Bearer ${token}`).send(body);
}

test('招募成功：扣减基础资源与行动点，兵加入部队', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  const troop = getTroopType(2); // 弓手
  assert.ok(troop);
  const count = 10;

  const res = await postRecruit(token, { generalId, soldierLevel: 2, count });
  assert.equal(res.status, 200);
  const updated = res.body.user as UserProfile;

  // 资源扣减：粮草/铁材/金币按成本 × 数量，稀有材料不变
  assert.equal(updated.resources.food, user.resources.food - troop.cost.food * count);
  assert.equal(updated.resources.iron, user.resources.iron - troop.cost.iron * count);
  assert.equal(updated.resources.gold, user.resources.gold - troop.cost.gold * count);
  assert.equal(updated.resources.rare, user.resources.rare, '招募不消耗稀有材料');

  // 部队编成：原有乡勇保留，新增弓手
  const army = updated.generals[0].army;
  const starter = army.find((u) => u.soldierLevel === 1);
  const recruited = army.find((u) => u.soldierLevel === 2);
  assert.equal(starter?.soldierType, '乡勇');
  assert.equal(starter?.count, 100, '原有乡勇数量不变');
  assert.equal(recruited?.soldierType, '弓手');
  assert.equal(recruited?.count, count, '新增弓手数量');

  // 行动点扣减 1 点
  assert.equal(res.body.actionPoints.current, AP_MAX - ACTION_COSTS.recruit);
});

test('招募资源不足返回 400，资源与部队不变', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  // 混沌主宰 1 名需 14000 粮草 > 初始 5000，必然不足
  const res = await postRecruit(token, { generalId, soldierLevel: 15, count: 1 });
  assert.equal(res.status, 400);

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user.resources, user.resources, '资源应保持不变');
  assert.deepEqual(me.body.user.generals[0].army, user.generals[0].army, '部队应保持不变');
});

test('兵种等级无效返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const generalId = (reg.body.user as UserProfile).generals[0].id;

  const over = await postRecruit(token, { generalId, soldierLevel: 16, count: 1 });
  assert.equal(over.status, 400);
  const under = await postRecruit(token, { generalId, soldierLevel: 0, count: 1 });
  assert.equal(under.status, 400);
});

test('招募数量无效返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const generalId = (reg.body.user as UserProfile).generals[0].id;

  const zero = await postRecruit(token, { generalId, soldierLevel: 1, count: 0 });
  assert.equal(zero.status, 400);
  const neg = await postRecruit(token, { generalId, soldierLevel: 1, count: -3 });
  assert.equal(neg.status, 400);
});

test('未登录招募返回 401', { skip }, async () => {
  const res = await request(app)
    .post('/api/recruit')
    .send({ generalId: 'x', soldierLevel: 1, count: 1 });
  assert.equal(res.status, 401);
});

test('招募他人武将返回 400', { skip }, async () => {
  const a = await register(uniqueUsername(), 'secret123');
  const b = await register(uniqueUsername(), 'secret123');
  const aGeneralId = (a.body.user as UserProfile).generals[0].id;

  const res = await postRecruit(b.body.token as string, { generalId: aGeneralId, soldierLevel: 1, count: 1 });
  assert.equal(res.status, 400);
});

test('同兵种多次招募合并数量', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  await postRecruit(token, { generalId, soldierLevel: 3, count: 5 });
  const res = await postRecruit(token, { generalId, soldierLevel: 3, count: 3 });
  assert.equal(res.status, 200);

  const army = (res.body.user as UserProfile).generals[0].army;
  const daodun = army.find((u) => u.soldierLevel === 3);
  assert.equal(daodun?.soldierType, '刀盾手');
  assert.equal(daodun?.count, 8, '两次招募应合并为 8 名刀盾手');
});