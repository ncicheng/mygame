import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ACTION_COSTS, TROOP_CATALOG, getTroopType } from '@mygame/shared';

// 单元测试：不依赖数据库，验证兵种表数据与招募路由的入参校验

const TROOP_NAMES = [
  '乡勇',
  '弓手',
  '刀盾手',
  '铁骑',
  '重甲步兵',
  '弩兵',
  '虎贲',
  '铁浮屠',
  '神机营',
  '天策上将',
  '镇国大将军',
  '九天玄女兵',
  '太古龙骑',
  '修罗战鬼',
  '混沌主宰',
];

test('兵种表包含 1-15 级全部兵种，名称与顺序精确', () => {
  assert.equal(TROOP_CATALOG.length, 15, '兵种表应有 15 项');
  TROOP_CATALOG.forEach((t, i) => {
    assert.equal(t.level, i + 1, `第 ${i + 1} 项等级应为 ${i + 1}`);
    assert.equal(t.name, TROOP_NAMES[i], `等级 ${i + 1} 兵种名应为 ${TROOP_NAMES[i]}`);
  });
});

test('兵种成本只消耗基础资源（粮草/铁材/金币），不消耗稀有材料', () => {
  for (const t of TROOP_CATALOG) {
    assert.ok(t.cost.food > 0, `${t.name} 应消耗粮草`);
    assert.ok(t.cost.iron >= 0, `${t.name} 铁材成本非负`);
    assert.ok(t.cost.gold >= 0, `${t.name} 金币成本非负`);
    assert.equal(t.cost.rare, 0, '招募不消耗稀有材料（打野产出，养成用）');
  }
});

test('兵种战力随等级递增', () => {
  for (let i = 1; i < TROOP_CATALOG.length; i++) {
    assert.ok(
      TROOP_CATALOG[i].power > TROOP_CATALOG[i - 1].power,
      `等级 ${i + 1} 战力应高于等级 ${i}`,
    );
  }
});

test('getTroopType 返回对应等级兵种，越界返回 null', () => {
  assert.equal(getTroopType(1)?.name, '乡勇');
  assert.equal(getTroopType(15)?.name, '混沌主宰');
  assert.equal(getTroopType(0), null);
  assert.equal(getTroopType(16), null);
});

test('行动点常量：招募消耗 1 行动点', () => {
  assert.equal(ACTION_COSTS.recruit, 1);
});

test('POST /api/recruit 无 token 返回 401', async () => {
  const app = createApp({ db: null });
  const res = await request(app)
    .post('/api/recruit')
    .send({ generalId: 'g1', soldierLevel: 1, count: 1 });
  assert.equal(res.status, 401);
});

test('POST /api/recruit 未连接数据库且带 token 时返回 503', async () => {
  const app = createApp({ db: null });
  const res = await request(app)
    .post('/api/recruit')
    .set('Authorization', 'Bearer some-token')
    .send({ generalId: 'g1', soldierLevel: 1, count: 1 });
  assert.equal(res.status, 503);
});