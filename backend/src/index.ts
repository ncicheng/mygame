import 'dotenv/config';
import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { setupSocket } from './socket.js';

const port = Number(process.env.PORT ?? 3001);
const db = createDb(process.env.DATABASE_URL);
const app = createApp({ db });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// socket 认证 + 按世界房间推送的世界时钟：客户端只收到其所在世界的行军位置
setupSocket(io, db);

server.listen(port, () => {
  console.log(`[mygame] backend listening on http://localhost:${port} (db=${db ? 'configured' : 'unset'})`);
});
