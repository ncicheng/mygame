import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ACTION_COSTS, AP_MAX, type BattleReportsResponse, type UserProfile, type WorldStateResponse } from '@mygame/shared';

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

function uniqueUsername(): string {
  return `u${randomUUID().slice(0, 8)}`;
}

async function register(username: string, password: string) {
  return request(app).post('/api/auth/register').send({ username, password });
}

function postMarch(token: string, body: Record<string, unknown>) {
  return request(app).post('/api/march').set('Authorization', `Bearer ${token}`).send(body);
}

function getWorld(token: string) {
  return request(app).get('/api/world').set('Authorization', `Bearer ${token}`);
}

function getReports(token: string) {
  return request(app).get('/api/battle/reports').set('Authorization', `Bearer ${token}`);
}

/** 行军到某格并把时间拨到过去，使行军已到点（触发结算） */
async function marchAndArrive(token: string, generalId: string, x: number, y: number): Promise<void> {
  const res = await postMarch(token, { generalId, targetX: x, targetY: y });
  assert.equal(res.status, 200, '行军发布应成功');
  const marchId = res.body.march.id as string;
  await db!.query(
    "UPDATE marches SET departed_at = now() - interval '1 hour', arrives_at = now() - interval '1 minute' WHERE id = $1",
    [marchId],
  );
}

/** 取地图上首个野地 */
async function firstWildland(token: string) {
  const ws = (await getWorld(token)).body as WorldStateResponse;
  const wl = ws.wildlands[0];
  assert.ok(wl, '世界应存在野地');
  return wl;
}

test('行军至野地胜利：战斗实例创建、掉落稀有材料、战报写入、野地被攻破', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  const ws = (await getWorld(token)).body as WorldStateResponse;
  const wl = ws.wildlands[0];

  // 削弱该野地守军，使战斗必然胜利（确定性）
  await db!.query('UPDATE wildlands SET strength = 1 WHERE id = $1', [wl.id]);

  await marchAndArrive(token, generalId, wl.x, wl.y);

  const after = (await getWorld(token)).body as WorldStateResponse;
  const me = after.armies.find((a) => a.side === 'me')!;
  assert.equal(me.x, wl.x, '胜利后部队应留在野地格');
  assert.equal(me.y, wl.y);
  // 打野消耗行动点：出征 1 + 战斗 2
  assert.equal(after.actionPoints.current, AP_MAX - ACTION_COSTS.march - ACTION_COSTS.bandit);

  // 战报写入
  const reports = (await getReports(token)).body as BattleReportsResponse;
  assert.equal(reports.reports.length, 1);
  const report = reports.reports[0];
  assert.equal(report.victory, true);
  assert.equal(report.wildlandName, wl.name);
  assert.ok(report.log.attackerWon, '战报日志应标记攻击方胜利');
  assert.ok(report.log.rounds.length > 0, '战报应含播放回合序列');
  // 威吓自动释放：攻击方战力(远大于 1)不低于守方 → 技能应真正生效并写入
  assert.equal(report.log.skillUsed, true, '攻击方战力不低于守方时应自动释放威吓');
  const inst = await db!.query(
    'SELECT skill_used FROM battle_instances WHERE defender_wildland_id = $1 AND attacker_general_id = $2 ORDER BY created_at DESC LIMIT 1',
    [wl.id, generalId],
  );
  assert.equal(inst.rows[0].skill_used, true, 'battle_instances 应持久化 skill_used = true');

  // 稀有材料掉落：强度 1 → 掉落 1
  const me2 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal((me2.body.user as UserProfile).resources.rare, user.resources.rare + 1, '胜利应掉落 1 稀有材料');

  // 野地被攻破进入刷新
  const wlRes = await db!.query('SELECT defeated_at FROM wildlands WHERE id = $1', [wl.id]);
  assert.ok(wlRes.rows[0].defeated_at !== null, '胜利后野地应标记为被攻破');
});

test('战败：武将重伤回城（不掉级）、兵战损落库、不掉稀有材料', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  const ws = (await getWorld(token)).body as WorldStateResponse;
  const wl = ws.wildlands[0];
  const home = ws.cities.find((c) => c.side === 'me')!;

  // 剥离部队与武器 → 攻击方战力为 0，必然战败（确定性）
  await db!.query('DELETE FROM army_units WHERE general_id = $1', [generalId]);
  await db!.query('UPDATE generals SET weapon_id = NULL WHERE id = $1', [generalId]);

  await marchAndArrive(token, generalId, wl.x, wl.y);

  const after = (await getWorld(token)).body as WorldStateResponse;
  const me = after.armies.find((a) => a.side === 'me')!;
  assert.equal(me.x, home.x, '战败后武将应重伤回城');
  assert.equal(me.y, home.y);
  assert.equal(me.troopCount, 0, '兵战损落库后部队应无兵');

  // 武将不灭、不掉级
  const prof = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const general = (prof.body.user as UserProfile).generals[0];
  assert.equal(general.level, user.generals[0].level, '战败不掉级');

  // 不掉稀有材料
  assert.equal(general.army.length, 0);
  const reports = (await getReports(token)).body as BattleReportsResponse;
  assert.equal(reports.reports[0].victory, false, '战报应标记失败');
  assert.equal(reports.reports[0].droppedRare, 0, '战败不掉落稀有材料');
  assert.equal(reports.reports[0].log.skillUsed, false, '攻击方战力低于守方时威吓不释放');

  // 野地未被攻破
  const wlRes = await db!.query('SELECT defeated_at FROM wildlands WHERE id = $1', [wl.id]);
  assert.ok(wlRes.rows[0].defeated_at === null, '战败不应攻破野地');
});

test('行军到非野地格不触发战斗，战报为空', { skip }, async () => {
  const reg = await register(uniqueUsername(), 'secret123');
  const token = reg.body.token as string;
  const user = reg.body.user as UserProfile;
  const generalId = user.generals[0].id;
  const ws = (await getWorld(token)).body as WorldStateResponse;
  const me = ws.armies.find((a) => a.side === 'me')!;
  const wl = ws.wildlands[0];

  // 找一个非野地、非武将所在的普通格
  let target = { x: 0, y: 0 };
  outer: for (let y = 0; y < ws.world.height; y++) {
    for (let x = 0; x < ws.world.width; x++) {
      const isWild = ws.wildlands.some((w) => w.x === x && w.y === y);
      const isArmy = ws.armies.some((a) => a.x === x && a.y === y);
      const isCity = ws.cities.some((c) => c.x === x && c.y === y);
      if (!isWild && !isArmy && !isCity && !(x === wl.x && y === wl.y)) {
        target = { x, y };
        break outer;
      }
    }
  }

  await marchAndArrive(token, generalId, target.x, target.y);

  const reports = (await getReports(token)).body as BattleReportsResponse;
  assert.equal(reports.reports.length, 0, '普通格行军不应产生战报');
});

test('未登录读取战报返回 401', { skip }, async () => {
  const res = await request(app).get('/api/battle/reports');
  assert.equal(res.status, 401);
});
