import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AP_MAX, ACTION_COSTS, type WorldConfig } from '@mygame/shared';
import { WORLD_CONFIG, findStartTile, generateTerrain } from '../src/world.js';
import { computeActionPoints } from '../src/actionPoints.js';

// 单元测试：不依赖数据库，仅验证世界地形生成、落位与行动点恢复的纯逻辑
const config: WorldConfig = { ...WORLD_CONFIG, width: 8, height: 6 };

test('generateTerrain 返回指定尺寸，且所有格字符均为合法地形', () => {
  const rows = generateTerrain(config.width, config.height, 123);
  assert.equal(rows.length, config.height);
  for (const row of rows) {
    assert.equal(row.length, config.width);
    for (const ch of row) {
      assert.ok('gfwm'.includes(ch), `非法地形字符 ${ch}`);
    }
  }
});

test('generateTerrain 同一种子输出确定，且包含非平原地形', () => {
  const a = generateTerrain(20, 14, 42);
  const b = generateTerrain(20, 14, 42);
  assert.deepEqual(a, b, '同一世界种子应产生同一张地图');
  assert.ok(a.some((row) => /[fmw]/.test(row)), '地图应包含林地/山地/水域');
});

test('generateTerrain 不同种子输出不同', () => {
  assert.notDeepEqual(generateTerrain(20, 14, 1), generateTerrain(20, 14, 2));
});

test('findStartTile 从地图中心开始螺旋向外，返回首个满足条件的格子', () => {
  const tile = findStartTile(20, 14, () => true);
  assert.deepEqual(tile, { x: 10, y: 7 });
});

test('findStartTile 跳过不满足条件的格子', () => {
  // 排除中心后，环 1 内首个偶数坐标格为 (10,6)
  const tile = findStartTile(20, 14, (x, y) => !(x === 10 && y === 7) && x % 2 === 0 && y % 2 === 0);
  assert.deepEqual(tile, { x: 10, y: 6 });
});

test('findStartTile 全部占用时返回 null', () => {
  assert.equal(findStartTile(3, 3, () => false), null);
});

test('computeActionPoints 每满一个恢复周期补 1 点，最多封顶到上限', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  const recoverMs = 10 * 60 * 1000;
  const s1 = computeActionPoints(3, AP_MAX, base, new Date(base.getTime() + recoverMs), recoverMs);
  assert.equal(s1.current, 4, '满一个周期应补 1 点');
  const s2 = computeActionPoints(3, AP_MAX, base, new Date(base.getTime() + 25 * 60 * 1000), recoverMs);
  assert.equal(s2.current, AP_MAX, '补点应封顶到上限');
  const s3 = computeActionPoints(AP_MAX, AP_MAX, base, base, recoverMs);
  assert.equal(s3.nextRecoveryAt, null, '满点后不再安排下次恢复');
});

test('computeActionPoints 未满一个周期时不补点', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  const s = computeActionPoints(4, AP_MAX, base, new Date(base.getTime() + 9 * 60 * 1000), 10 * 60 * 1000);
  assert.equal(s.current, 4);
});

test('行动点常量：上限 5，出征/打野/攻城消耗规则就位', () => {
  assert.equal(AP_MAX, 5);
  assert.equal(ACTION_COSTS.march, 1);
  assert.equal(ACTION_COSTS.bandit, 2);
  assert.equal(ACTION_COSTS.siege, 3);
});

test('GET /api/world 未连接数据库且带 token 时返回 503', async () => {
  const app = createApp({ db: null });
  const res = await request(app).get('/api/world').set('Authorization', 'Bearer some-token');
  assert.equal(res.status, 503);
});