import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { STARTER_ARMY, STARTER_WEAPON, STARTER_RESOURCES } from '../src/starter.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import type { UserProfile } from '@mygame/shared';

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

test(
  '注册后自动获得初始武将（Lv.1 乡勇部队）与初始资源',
  { skip },
  async () => {
    const username = uniqueUsername();
    const res = await register(username, 'secret123');

    assert.equal(res.status, 201);
    assert.equal(typeof res.body.token, 'string');
    assert.ok(res.body.token.length > 20);

    const user = res.body.user as UserProfile;
    assert.equal(user.username, username);
    assert.equal(typeof user.registeredAt, 'string');
    assert.deepEqual(user.resources, STARTER_RESOURCES);
    assert.equal(user.generals.length, 1);

    const general = user.generals[0];
    assert.equal(general.level, 1);
    assert.deepEqual(general.army, STARTER_ARMY);
    assert.equal(general.weapon?.name, STARTER_WEAPON.name);
    assert.equal(general.weapon?.tier, STARTER_WEAPON.tier);
  },
);

test('注册时用户名被占用返回 409', { skip }, async () => {
  const username = uniqueUsername();
  await register(username, 'secret123');
  const res = await register(username, 'secret456');

  assert.equal(res.status, 409);
});

test('并发注册同名：仅一个成功，其余返回 409 而非 500', { skip }, async () => {
  const username = uniqueUsername();
  const results = await Promise.all([
    register(username, 'secret123'),
    register(username, 'secret123'),
    register(username, 'secret123'),
    register(username, 'secret123'),
    register(username, 'secret123'),
  ]);
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, '仅一个注册成功');
  assert.equal(statuses.filter((s) => s === 500).length, 0, '并发重名不应返回 500');
  assert.equal(statuses.filter((s) => s === 409).length, 4, '其余应返回 409');
});

test('注册时密码以哈希存储（不存明文）', { skip }, async () => {
  const username = uniqueUsername();
  const password = 'plaintext-secret';
  await register(username, password);

  const { rows } = await db!.query('SELECT password_hash FROM users WHERE username = $1', [username]);
  assert.equal(rows.length, 1);
  const stored = rows[0].password_hash as string;
  assert.notEqual(stored, password);
  assert.ok(stored.length > 20);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword('wrong-password', stored), false);
});

test('登录成功返回 token 与用户档案', { skip }, async () => {
  const username = uniqueUsername();
  await register(username, 'secret123');

  const res = await request(app).post('/api/auth/login').send({ username, password: 'secret123' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.user.username, username);
});

test('登录密码错误返回 401', { skip }, async () => {
  const username = uniqueUsername();
  await register(username, 'secret123');

  const res = await request(app).post('/api/auth/login').send({ username, password: 'wrong' });
  assert.equal(res.status, 401);
});

test('GET /api/auth/me 携带有效 token 返回当前用户', { skip }, async () => {
  const username = uniqueUsername();
  const reg = await register(username, 'secret123');
  const token = reg.body.token as string;

  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, username);
});

test('GET /api/auth/me 携带无效 token 返回 401', { skip }, async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer invalid-token');
  assert.equal(res.status, 401);
});

test('登出后 token 失效', { skip }, async () => {
  const username = uniqueUsername();
  const reg = await register(username, 'secret123');
  const token = reg.body.token as string;

  const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
  assert.equal(out.status, 200);

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 401);
});