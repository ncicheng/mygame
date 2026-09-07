import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { AP_MAX, ACTION_COSTS, MARCH_TILE_MS, type UserProfile, type WorldStateResponse } from '@mygame/shared';

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

function postMarch(token: string, body: Record<string, unknown>) {
  return request(app).post('/api/march').set('Authorization', `Bearer ${token}`).send(body);
}

function cancelMarch(token: string, marchId: string) {
  return request(app).post('/api/march/cancel').set('Authorization', `Bearer ${token}`).send({ marchId });
}

function getWorld(token: string) {
  return request(app).get('/api/world').set('Authorization', `Bearer ${token}`);
}

/** 寻找一个不在武将当前格、且在地图内的目标格 */
async function pickTarget(token: string, current: { x: number; y: number }) {
  const ws = (await getWorld(token)).body as WorldStateResponse;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < 0 || y < 0 || x >= ws.world.width || y >= ws.world.height) {
        continue;
      }
      if (x === current.x && y === current.y) {
        continue;
      }
      return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

test('发布行军成功：行动点扣减、行军记录写入、世界反映行军中的部队', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const before = (await getWorld(token)).body as WorldStateResponse;
  const myArmy = before.armies.find((a) => a.side === 'me')!;
  const target = await pickTarget(token, { x: myArmy.x, y: myArmy.y });

  const res = await postMarch(token, { generalId, targetX: target.x, targetY: target.y });
  assert.equal(res.status, 200);
  assert.equal(res.body.march.status, 'active');
  assert.equal(res.body.march.generalId, generalId);
  assert.equal(res.body.march.targetX, target.x);
  assert.equal(res.body.march.targetY, target.y);
  assert.equal(res.body.march.originX, myArmy.x);
  assert.equal(res.body.march.originY, myArmy.y);
  // 行动点扣减 1 点
  assert.equal(res.body.actionPoints.current, AP_MAX - ACTION_COSTS.march);

  // 世界返回中，我方部队带着行军信息（位置尚未推进，仍在起点）
  const ws = (await getWorld(token)).body as WorldStateResponse;
  const marching = ws.armies.find((a) => a.side === 'me')!;
  assert.ok(marching.march, '行军中的部队应携带行军信息');
  assert.equal(marching.march!.targetX, target.x);
  assert.equal(marching.march!.targetY, target.y);
  assert.equal(marching.x, myArmy.x);
  assert.equal(marching.y, myArmy.y);
});

test('目标格超出地图范围返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  const ws = (await getWorld(token)).body as WorldStateResponse;
  const w = ws.world;

  const res = await postMarch(token, { generalId, targetX: w.width + 5, targetY: w.height + 5 });
  assert.equal(res.status, 400);
});

test('行军到自身所在格返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const ws = (await getWorld(token)).body as WorldStateResponse;
  const myArmy = ws.armies.find((a) => a.side === 'me')!;

  const res = await postMarch(token, { generalId, targetX: myArmy.x, targetY: myArmy.y });
  assert.equal(res.status, 400);
});

test('未登录发布行军返回 401', { skip }, async () => {
  const res = await request(app).post('/api/march').send({ generalId: 'x', targetX: 3, targetY: 3 });
  assert.equal(res.status, 401);
});

test('行军他人武将返回 400', { skip }, async () => {
  const a = await register(uniqueUsername(), 'secret123');
  const b = await register(uniqueUsername(), 'secret123');
  const aGeneralId = (a.body.user as UserProfile).generals[0].id;

  const res = await postMarch(b.body.token as string, { generalId: aGeneralId, targetX: 3, targetY: 3 });
  assert.equal(res.status, 400);
});

test('部队行军中再次下达行军返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const ws = (await getWorld(token)).body as WorldStateResponse;
  const myArmy = ws.armies.find((a) => a.side === 'me')!;
  const target = await pickTarget(token, { x: myArmy.x, y: myArmy.y });

  await postMarch(token, { generalId, targetX: target.x, targetY: target.y });
  const again = await postMarch(token, { generalId, targetX: target.x + 1, targetY: target.y });
  assert.equal(again.status, 400);
});

test('取消行军：部队返回起点，行军命令结束', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const ws = (await getWorld(token)).body as WorldStateResponse;
  const myArmy = ws.armies.find((a) => a.side === 'me')!;
  const target = await pickTarget(token, { x: myArmy.x, y: myArmy.y });

  const created = await postMarch(token, { generalId, targetX: target.x, targetY: target.y });
  const marchId = created.body.march.id as string;

  const res = await cancelMarch(token, marchId);
  assert.equal(res.status, 200);
  assert.equal(res.body.march.status, 'cancelled');

  const after = (await getWorld(token)).body as WorldStateResponse;
  const back = after.armies.find((a) => a.side === 'me')!;
  assert.equal(back.x, myArmy.x, '取消后部队应回到起点');
  assert.equal(back.y, myArmy.y);
  assert.equal(back.march, null, '取消后不再有进行中的行军');
});

test('到达后状态落库：行军到点后部队停到目标格', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const ws = (await getWorld(token)).body as WorldStateResponse;
  const myArmy = ws.armies.find((a) => a.side === 'me')!;
  const target = await pickTarget(token, { x: myArmy.x, y: myArmy.y });

  const created = await postMarch(token, { generalId, targetX: target.x, targetY: target.y });
  const marchId = created.body.march.id as string;

  // 把出发/到达时间拨到过去，使行军已到点（无需真等 MARCH_TILE_MS 毫秒）
  await db!.query(
    "UPDATE marches SET departed_at = now() - interval '1 hour', arrives_at = now() - interval '1 minute' WHERE id = $1",
    [marchId],
  );

  const after = (await getWorld(token)).body as WorldStateResponse;
  const arrived = after.armies.find((a) => a.side === 'me')!;
  assert.equal(arrived.x, target.x, '到达后部队应落在目标格');
  assert.equal(arrived.y, target.y);
  assert.equal(arrived.march, null, '到达后不再有进行中的行军');
});

test('行军时长 = 距离 × 每格耗时（响应中到达时间正确）', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const ws = (await getWorld(token)).body as WorldStateResponse;
  const myArmy = ws.armies.find((a) => a.side === 'me')!;
  const target = await pickTarget(token, { x: myArmy.x, y: myArmy.y });
  const dist = Math.abs(target.x - myArmy.x) + Math.abs(target.y - myArmy.y);

  const res = await postMarch(token, { generalId, targetX: target.x, targetY: target.y });
  const departed = new Date(res.body.march.departedAt as string).getTime();
  const arrives = new Date(res.body.march.arrivesAt as string).getTime();
  assert.equal(arrives - departed, dist * MARCH_TILE_MS);
});
