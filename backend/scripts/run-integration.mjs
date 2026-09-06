// 集成测试运行器：优先使用已有 DATABASE_URL（如 CI 托管库），
// 否则用 embedded-postgres 启动真实本地 Postgres（无需系统安装）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const env = { ...process.env };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

let pg;

if (!env.DATABASE_URL) {
  console.log('[integration] 未检测到 DATABASE_URL，启动 embedded-postgres（真实本地 PostgreSQL）…');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const port = 15432;
  const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'mygame-pg-'));
  pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
  });
  await pg.initialise();
  await pg.start();

  const client = new Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query('CREATE DATABASE mygame_test');
  await client.end();

  env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/mygame_test`;
} else {
  console.log('[integration] 使用已有 DATABASE_URL');
}

console.log(`[integration] DATABASE_URL=${env.DATABASE_URL}`);

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', 'test/db.integration.test.ts'],
  { cwd: backendRoot, env, stdio: 'inherit' },
);

child.on('exit', async (code) => {
  if (pg) {
    await pg.stop();
  }
  process.exit(code ?? 1);
});