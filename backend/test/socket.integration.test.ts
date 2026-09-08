import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { setupSocket } from '../src/socket.js';
import type { UserProfile, WorldStateResponse } from '@mygame/shared';

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

async function getWorld(token: string) {
  return request(app).get('/api/world').set('Authorization', `Bearer ${token}`);
}

function postMarch(token: string, body: Record<string, unknown>) {
  return request(app).post('/api/march').set('Authorization', `Bearer ${token}`).send(body);
}

/** 启动一个带 socket.io 的临时 HTTP 服务，返回端口与关闭句柄 */
async function startServer(tickMs: number): Promise<{
  port: number;
  stop(): Promise<void>;
}> {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const runtime = setupSocket(io, databaseUrl ? db : null, tickMs);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        runtime.stop();
        io.close();
        httpServer.close(() => resolve());
      }),
  };
}

/** 以给定 token 认证连接 socket，等待 connect 完成 */
function connect(port: number, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://localhost:${port}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

test('WS 按世界隔离：世界 A 的 socket 收不到世界 B 的行军推送', { skip }, async () => {
  const regA = await register(uniqueUsername(), 'secret123');
  const regB = await register(uniqueUsername(), 'secret123');
  const tokenA = regA.body.token as string;
  const tokenB = regB.body.token as string;
  const userB = regB.body.user as UserProfile;
  const generalB = userB.generals[0].id;

  const worldA = (await getWorld(tokenA)).body.world.id as string;

  // 为 B 单独建一个世界，并把 B 的武将挪过去
  const worldB = randomUUID();
  await db!.query('INSERT INTO worlds (id, name, width, height, seed) VALUES ($1, $2, 20, 14, 9999)', [worldB, '世界B']);
  await db!.query('UPDATE generals SET world_id = $1 WHERE id = $2', [worldB, generalB]);

  // B 在 worldB 下达一条行军（保持 active：到达时间在未来）
  const wsB = (await getWorld(tokenB)).body as WorldStateResponse;
  const bArmy = wsB.armies.find((a) => a.side === 'me')!;
  const target = { x: bArmy.x === 0 ? 1 : bArmy.x - 1, y: bArmy.y };
  const created = await postMarch(tokenB, { generalId: generalB, targetX: target.x, targetY: target.y });
  assert.equal(created.status, 200);

  const { port, stop } = await startServer(50);
  const receivedA: unknown[] = [];
  const receivedB: unknown[] = [];
  try {
    const socketB = await connect(port, tokenB);
    const socketA = await connect(port, tokenA);
    socketB.on('march:update', (u: unknown) => receivedB.push(u));
    socketA.on('march:update', (u: unknown) => receivedA.push(u));

    // 等若干个世界时钟 tick（50ms × 6）
    await new Promise((r) => setTimeout(r, 300));

    socketA.disconnect();
    socketB.disconnect();
  } finally {
    await stop();
  }

  assert.ok(receivedB.length >= 1, '世界 B 的 socket 应收到其所在世界的行军推送');
  assert.equal(receivedA.length, 0, '世界 A 的 socket 不应收到世界 B 的行军推送');
  void worldA;
});
