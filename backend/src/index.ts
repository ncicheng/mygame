import 'dotenv/config';
import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { createDb } from './db.js';

const port = Number(process.env.PORT ?? 3001);
const db = createDb(process.env.DATABASE_URL);
const app = createApp({ db });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', () => {
  // 占位：后续任务接入世界状态实时推送
});

server.listen(port, () => {
  console.log(`[mygame] backend listening on http://localhost:${port} (db=${db ? 'configured' : 'unset'})`);
});