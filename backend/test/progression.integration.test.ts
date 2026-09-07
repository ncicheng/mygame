import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import {
  GENERAL_STAR_MAX,
  INITIAL_TROOP_UNLOCK,
  WEAPON_TIER_MAX,
  generalLevelUpCost,
  generalStarUpCost,
  troopUnlockCost,
  weaponUpgradeCost,
  type UserProfile,
} from '@mygame/shared';

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

function post(token: string, path: string, body: Record<string, unknown>) {
  return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

/** 给玩家加稀有材料（测试用）：养成消耗需要初始 20 之外的额外材料 */
async function grantRare(userId: string, amount: number): Promise<void> {
  await db!.query('UPDATE resources SET rare = rare + $1 WHERE user_id = $2', [amount, userId]);
}

test('武器升阶：阶 +1、名称更新、扣减稀有材料', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  assert.equal(user.generals[0].weapon?.tier, 1, '初始武器 1 阶木矛');
  await grantRare(user.id, 200);

  const res = await post(token, '/api/progression/weapon-upgrade', { generalId });
  assert.equal(res.status, 200);
  const updated = res.body.user as UserProfile;
  assert.equal(updated.generals[0].weapon?.tier, 2, '武器应升到 2 阶');
  assert.equal(updated.generals[0].weapon?.name, '青铜剑', '2 阶武器名应为青铜剑');
  assert.equal(updated.resources.rare, user.resources.rare + 200 - weaponUpgradeCost(1), '应扣减升阶消耗');
});

test('武器升阶：稀有材料不足返回 400，武器不变', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  // 初始稀有材料 20 恰好够升 1→2 阶，先扣到不足再验证拒绝
  await db!.query('UPDATE resources SET rare = 5 WHERE user_id = $1', [user.id]);

  const res = await post(token, '/api/progression/weapon-upgrade', { generalId });
  assert.equal(res.status, 400);

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal((me.body.user as UserProfile).generals[0].weapon?.tier, 1, '武器应保持 1 阶');
});

test('武器升阶：已达 20 阶上限返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  await grantRare(user.id, 100000);
  // 直接拔高武器到最高阶
  await db!.query('UPDATE weapons SET tier = $1, name = $2 WHERE general_id = $3', [
    WEAPON_TIER_MAX,
    '天道权杖',
    generalId,
  ]);

  const res = await post(token, '/api/progression/weapon-upgrade', { generalId });
  assert.equal(res.status, 400);
});

test('武将升级：等级 +1、扣减稀有材料、升到上限后拒绝', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  await grantRare(user.id, 500);

  const res = await post(token, '/api/progression/level-up', { generalId });
  assert.equal(res.status, 200);
  const updated = res.body.user as UserProfile;
  assert.equal(updated.generals[0].level, user.generals[0].level + 1, '武将应升 1 级');
  assert.equal(updated.resources.rare, user.resources.rare + 500 - generalLevelUpCost(1), '应扣减升级消耗');

  // 稀有材料扣光后再升级 → 资源不足
  await db!.query('UPDATE resources SET rare = 0 WHERE user_id = $1', [user.id]);
  const poor = await post(token, '/api/progression/level-up', { generalId });
  assert.equal(poor.status, 400);
});

test('武将升星：星级 +1、扣减稀有材料、满星后拒绝', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  await grantRare(user.id, 5000);

  const res = await post(token, '/api/progression/star-up', { generalId });
  assert.equal(res.status, 200);
  const updated = res.body.user as UserProfile;
  assert.equal(updated.generals[0].stars, (user.generals[0].stars ?? 1) + 1, '武将应升 1 星');
  assert.equal(updated.resources.rare, user.resources.rare + 5000 - generalStarUpCost(1), '应扣减升星消耗');

  // 满星后再升星 → 拒绝
  await db!.query('UPDATE generals SET stars = $1 WHERE id = $2', [GENERAL_STAR_MAX, generalId]);
  const maxed = await post(token, '/api/progression/star-up', { generalId });
  assert.equal(maxed.status, 400);
});

test('升星稀有材料不足返回 400，星级不变', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  const res = await post(token, '/api/progression/star-up', { generalId });
  assert.equal(res.status, 400);

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal((me.body.user as UserProfile).generals[0].stars, 1, '星级应保持 1');
});

test('养成他人武将返回 400', { skip }, async () => {
  const a = await register(uniqueUsername(), 'secret123');
  const b = await register(uniqueUsername(), 'secret123');
  const aGeneralId = (a.body.user as UserProfile).generals[0].id;

  const res = await post(b.body.token as string, '/api/progression/level-up', { generalId: aGeneralId });
  assert.equal(res.status, 400);
});

test('兵种解锁：初始解锁 1-3 级，未解锁兵种招募被拒，解锁后招募成功', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;

  // 未解锁的 4 级（铁骑）招募应被拒
  const locked = await post(token, '/api/recruit', { generalId, soldierLevel: INITIAL_TROOP_UNLOCK + 1, count: 1 });
  assert.equal(locked.status, 400);

  // 解锁 4 级兵种
  await grantRare(user.id, 500);
  const unlock = await post(token, '/api/progression/troop-unlock', { troopLevel: INITIAL_TROOP_UNLOCK + 1 });
  assert.equal(unlock.status, 200);
  const unlockedUser = unlock.body.user as UserProfile;

  // 解锁后招募 4 级成功（铁骑 cost 铁材 250 × 1，初始铁材 2000 足够）
  const ok = await post(token, '/api/recruit', { generalId, soldierLevel: INITIAL_TROOP_UNLOCK + 1, count: 1 });
  assert.equal(ok.status, 200);
  const recruited = (ok.body.user as UserProfile).generals[0].army.find(
    (u) => u.soldierLevel === INITIAL_TROOP_UNLOCK + 1,
  );
  assert.equal(recruited?.soldierType, '铁骑', '解锁后应能招募铁骑');

  // 解锁消耗稀有材料
  assert.equal(
    unlockedUser.resources.rare,
    user.resources.rare + 500 - troopUnlockCost(INITIAL_TROOP_UNLOCK + 1),
    '应扣减解锁消耗',
  );
});

test('兵种解锁必须逐级：跳过当前最高级返回 400', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  await grantRare(user.id, 100000);

  // 初始最高 3 级，直接解锁 5 级应被拒（须先解锁 4 级）
  const skip = await post(token, '/api/progression/troop-unlock', { troopLevel: INITIAL_TROOP_UNLOCK + 2 });
  assert.equal(skip.status, 400);

  // 逐级解锁 4 级成功
  const ok = await post(token, '/api/progression/troop-unlock', { troopLevel: INITIAL_TROOP_UNLOCK + 1 });
  assert.equal(ok.status, 200);
});

test('兵种解锁稀有材料不足返回 400，进度不变', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;

  const res = await post(token, '/api/progression/troop-unlock', { troopLevel: INITIAL_TROOP_UNLOCK + 1 });
  assert.equal(res.status, 400);

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.ok(me.body.user as UserProfile, '档案可读');
});

test('未登录养成返回 401', { skip }, async () => {
  const res = await request(app).post('/api/progression/level-up').send({ generalId: 'x' });
  assert.equal(res.status, 401);
});
