import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { HealthResponse } from '@mygame/shared';

test('GET /api/health 在未配置 DATABASE_URL 时返回 ok 与 db=disconnected', async () => {
  const app = createApp({ db: null });
  const res = await request(app).get('/api/health');

  assert.equal(res.status, 200);
  const body = res.body as HealthResponse;
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'disconnected');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.timestamp, 'string');
});

test('GET /api/health 返回的 JSON 含 Content-Type application/json', async () => {
  const app = createApp({ db: null });
  const res = await request(app).get('/api/health');

  assert.match(res.headers['content-type'] ?? '', /application\/json/);
});