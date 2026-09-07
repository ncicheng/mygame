import 'dotenv/config';
import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { finalizeArrivedMarches, listActiveMarches } from './march.js';

const port = Number(process.env.PORT ?? 3001);
const db = createDb(process.env.DATABASE_URL);
const app = createApp({ db });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', () => {
  // 客户端连接即就绪；行军位置由下方世界时钟 tick 统一推送
});

// 服务器世界时钟：每秒结算到期的行军，并向在线客户端推送行军部队的实时插值位置。
// 半实时：客户端只渲染服务器权威计算的位置，不自行插值。
if (db) {
  const tickMs = 1000;
  setInterval(async () => {
    try {
      await finalizeArrivedMarches(db, null);
      const updates = await listActiveMarches(db, null);
      if (updates.length > 0) {
        io.emit('march:update', updates);
      }
    } catch (err) {
      console.error('[world-clock] 推进行军位置失败：', err);
    }
  }, tickMs);
}

server.listen(port, () => {
  console.log(`[mygame] backend listening on http://localhost:${port} (db=${db ? 'configured' : 'unset'})`);
});
