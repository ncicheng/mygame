import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { AP_MAX, ACTION_COSTS, type WorldStateResponse } from '@mygame/shared';
import { getActionPoints, trySpendActionPoints } from '../src/actionPoints.js';
import { ensureDefaultWorld } from '../src/world.js';
import { Client } from 'pg';

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
  '注册后世界状态：世界信息、地形网格、我方城池、野地、我方部队与行动点就位',
  { skip },
  async () => {
    const username = uniqueUsername();
    const reg = await register(username, 'secret123');
    const token = reg.body.token as string;

    const res = await request(app).get('/api/world').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const ws = res.body as WorldStateResponse;

    // 世界信息与地形网格尺寸
    assert.ok(ws.world.id);
    assert.ok(ws.world.name.length > 0);
    assert.ok(ws.world.width > 0 && ws.world.height > 0);
    assert.equal(ws.tiles.length, ws.world.height);
    for (const row of ws.tiles) {
      assert.equal(row.length, ws.world.width);
      for (const ch of row) assert.ok('gfwm'.includes(ch), `非法地形字符 ${ch}`);
    }

    // 我方城池恰一座，且与初始部队同格
    const myCities = ws.cities.filter((c) => c.side === 'me');
    assert.equal(myCities.length, 1, '应恰有一座我方城池');
    const myArmies = ws.armies.filter((a) => a.side === 'me');
    assert.equal(myArmies.length, 1, '应恰有一支我方部队');
    assert.equal(myArmies[0].generalName, '乡勇队长');
    assert.equal(myArmies[0].troopCount, 100);
    assert.equal(myCities[0].x, myArmies[0].x);
    assert.equal(myCities[0].y, myArmies[0].y);

    // 敌方城池与野地可见
    assert.ok(ws.cities.some((c) => c.side === 'enemy'), '世界应预置敌方城池');
    assert.ok(ws.wildlands.length > 0, '世界应预置野地');

    // 行动点：显示当前/上限，当前不超上限
    assert.equal(ws.actionPoints.max, AP_MAX);
    assert.ok(ws.actionPoints.current >= 0 && ws.actionPoints.current <= ws.actionPoints.max);
  },
);

test('两名玩家同世界：对方城池与部队对我方为敌方', { skip }, async () => {
  const a = await register(uniqueUsername(), 'secret123');
  const b = await register(uniqueUsername(), 'secret123');

  const resA = await request(app).get('/api/world').set('Authorization', `Bearer ${a.body.token}`);
  assert.equal(resA.status, 200);
  const wsA = resA.body as WorldStateResponse;
  assert.ok(wsA.cities.some((c) => c.side === 'enemy'), '应看到对方城池为敌方');
  assert.ok(wsA.armies.some((ar) => ar.side === 'enemy'), '应看到对方部队为敌方');
});

test('世界持久：同一用户重复请求返回同一世界', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');

  const g1 = await request(app).get('/api/world').set('Authorization', `Bearer ${reg.body.token}`);
  const g2 = await request(app).get('/api/world').set('Authorization', `Bearer ${reg.body.token}`);
  assert.equal((g1.body as WorldStateResponse).world.id, (g2.body as WorldStateResponse).world.id);
});

test('GET /api/world 无 token 返回 401', { skip }, async () => {
  const res = await request(app).get('/api/world');
  assert.equal(res.status, 401);
});

test('GET /api/world 无效 token 返回 401', { skip }, async () => {
  const res = await request(app).get('/api/world').set('Authorization', 'Bearer invalid-token');
  assert.equal(res.status, 401);
});

test('行动点消耗：足额时扣减成功，耗尽后不能透支', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const userId = reg.body.user.id as string;

  // 新账号满行动点；连续扣减 AP_MAX 次 1 点应全部成功
  for (let i = 0; i < AP_MAX; i++) {
    assert.equal(await trySpendActionPoints(db!, userId, ACTION_COSTS.march), true, `第 ${i + 1} 次扣减应成功`);
  }
  // 第 6 次应失败（已耗尽）
  assert.equal(await trySpendActionPoints(db!, userId, ACTION_COSTS.march), false);
});

test('行动点并发消耗原子性：多路并发扣减不超花', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const userId = reg.body.user.id as string;

  const cost = 2;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => trySpendActionPoints(db!, userId, cost)),
  );
  const succeeded = results.filter(Boolean).length;
  // 5 点每次扣 2：最多 floor(5/2)=2 次成功，绝不允许并发下全部按「读到相同余额」各自成功
  assert.equal(succeeded, Math.floor(AP_MAX / cost), '并发扣减应只允许足额次数成功');
  const { rows } = await db!.query('SELECT current FROM action_points WHERE user_id = $1', [userId]);
  assert.equal(rows[0].current, AP_MAX - succeeded * cost, '余额应为原值减成功次数 × 成本');
});

test('事务内行动点扣减随回滚撤销：ROLLBACK 后行动点不变', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const userId = reg.body.user.id as string;
  const before = (await getActionPoints(db!, userId)).current;

  const client = await db!.connect();
  try {
    await client.query('BEGIN');
    assert.equal(await trySpendActionPoints(client, userId, ACTION_COSTS.march), true);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const after = (await getActionPoints(db!, userId)).current;
  assert.equal(after, before, '回滚后行动点应还原');
});

test('并发首次引导（独立数据库）：默认世界不分裂、玩家落位不同格', { skip }, async () => {
  const baseUrl = process.env.DATABASE_URL!;
  const dbName = `bs_${randomUUID().slice(0, 8)}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const bsUrl = new URL(baseUrl);
  bsUrl.pathname = `/${dbName}`;
  const bsDb = createDb(bsUrl.toString());
  const bsApp = createApp({ db: bsDb });

  try {
    // 并发首次引导默认世界：应只建出一个世界
    const worldIds = await Promise.all([
      ensureDefaultWorld(bsDb!),
      ensureDefaultWorld(bsDb!),
      ensureDefaultWorld(bsDb!),
    ]);
    assert.equal(new Set(worldIds).size, 1, '并发首次建默认世界应得到同一世界');

    // 并发注册两名玩家：同一世界、不同落格
    const [a, b] = await Promise.all([
      request(bsApp).post('/api/auth/register').send({ username: `a${randomUUID().slice(0, 8)}`, password: 'secret123' }),
      request(bsApp).post('/api/auth/register').send({ username: `b${randomUUID().slice(0, 8)}`, password: 'secret123' }),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const wa = (await request(bsApp).get('/api/world').set('Authorization', `Bearer ${a.body.token}`)).body as WorldStateResponse;
    const wb = (await request(bsApp).get('/api/world').set('Authorization', `Bearer ${b.body.token}`)).body as WorldStateResponse;
    assert.equal(wa.world.id, wb.world.id, '两名玩家应处于同一默认世界');
    const myA = wa.armies.find((x) => x.side === 'me')!;
    const myB = wb.armies.find((x) => x.side === 'me')!;
    assert.notDeepEqual([myA.x, myA.y], [myB.x, myB.y], '两名玩家不应落在同一格');
  } finally {
    await bsDb?.end();
    const drop = new Client({ connectionString: baseUrl });
    await drop.connect();
    await drop.query(`DROP DATABASE ${dbName}`);
    await drop.end();
  }
});