import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { manhattanDistance, marchPositionAt, computeArrivalAt, type MarchSchedule } from '../src/march.js';
import { MARCH_TILE_MS } from '@mygame/shared';

// 单元测试：不依赖数据库，验证行军纯逻辑（插值/时长）与行军路由的入参边界

function schedule(
  overrides: Partial<MarchSchedule> = {},
): MarchSchedule {
  return {
    originX: 0,
    originY: 0,
    targetX: 2,
    targetY: 0,
    departedAt: new Date(0),
    arrivesAt: new Date(2 * MARCH_TILE_MS),
    ...overrides,
  };
}

test('曼哈顿距离：相邻格为 1，对角仅 x 方向求和', () => {
  assert.equal(manhattanDistance({ x: 0, y: 0 }, { x: 0, y: 0 }), 0);
  assert.equal(manhattanDistance({ x: 0, y: 0 }, { x: 1, y: 0 }), 1);
  assert.equal(manhattanDistance({ x: 0, y: 0 }, { x: 3, y: 2 }), 5);
  assert.equal(manhattanDistance({ x: 4, y: 5 }, { x: 1, y: 1 }), 7);
});

test('到达时间 = 出发时间 + 距离 × 每格耗时', () => {
  const arrived = computeArrivalAt(1000, 3);
  assert.equal(arrived.getTime(), 1000 + 3 * MARCH_TILE_MS);
});

test('行军插值：出发前停在起点', () => {
  const s = schedule({ departedAt: new Date(0), arrivesAt: new Date(2 * MARCH_TILE_MS) });
  assert.deepEqual(marchPositionAt(s, -1), { x: 0, y: 0 });
});

test('行军插值：过半（走 1 格）停在第 1 格', () => {
  const s = schedule({ departedAt: new Date(0), arrivesAt: new Date(2 * MARCH_TILE_MS) });
  assert.deepEqual(marchPositionAt(s, MARCH_TILE_MS), { x: 1, y: 0 });
});

test('行军插值：到达时刻停在目标格', () => {
  const s = schedule({ departedAt: new Date(0), arrivesAt: new Date(2 * MARCH_TILE_MS) });
  assert.deepEqual(marchPositionAt(s, 2 * MARCH_TILE_MS), { x: 2, y: 0 });
});

test('行军插值：超过到达时间后钳制在目标格', () => {
  const s = schedule({ departedAt: new Date(0), arrivesAt: new Date(2 * MARCH_TILE_MS) });
  assert.deepEqual(marchPositionAt(s, 999999), { x: 2, y: 0 });
});

test('行军插值：横向优先，先走满 x 再走 y', () => {
  const s = schedule({ originX: 0, originY: 0, targetX: 2, targetY: 2, arrivesAt: new Date(4 * MARCH_TILE_MS) });
  assert.deepEqual(marchPositionAt(s, 2 * MARCH_TILE_MS), { x: 2, y: 0 });
  assert.deepEqual(marchPositionAt(s, 3 * MARCH_TILE_MS), { x: 2, y: 1 });
});

test('POST /api/march 无 token 返回 401', async () => {
  const app = createApp({ db: null });
  const res = await request(app).post('/api/march').send({ generalId: 'g1', targetX: 3, targetY: 3 });
  assert.equal(res.status, 401);
});

test('POST /api/march 未连接数据库且带 token 时返回 503', async () => {
  const app = createApp({ db: null });
  const res = await request(app)
    .post('/api/march')
    .set('Authorization', 'Bearer some-token')
    .send({ generalId: 'g1', targetX: 3, targetY: 3 });
  assert.equal(res.status, 503);
});
