import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { ensureSchema, ensureArmyUnitsConstraint, ensureMarchActiveUnique } from '../src/schema.js';

// 集成测试：必须连真实本地 Postgres 才算通过（run-integration.mjs 用 embedded-postgres 提供）
const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl
  ? false
  : 'DATABASE_URL 未设置。运行 npm run test:integration（embedded-postgres 自动提供真实 Postgres）。';

const db = createDb(databaseUrl);

after(() => {
  void db?.end();
});

test('迁移：旧库 army_units 缺 UNIQUE 约束时补齐并合并重复行', { skip }, async () => {
  // 先确保当前 schema 就位（army_units 已存在），再在事务里模拟旧库并回滚，避免污染持久数据
  await ensureSchema(db);
  const client = await db.connect();
  await client.query('BEGIN');
  try {
    // 模拟 Task2/3 旧库：army_units 无 UNIQUE 约束，且 (general_id, soldier_level) 存在重复行
    await client.query('DROP TABLE army_units');
    await client.query(`CREATE TABLE army_units (
       id TEXT PRIMARY KEY,
       general_id TEXT NOT NULL,
       soldier_type TEXT NOT NULL,
       soldier_level INTEGER NOT NULL,
       count INTEGER NOT NULL
     )`);
    await client.query("INSERT INTO army_units VALUES ('dup1', 'g1', '乡勇', 1, 5)");
    await client.query("INSERT INTO army_units VALUES ('dup2', 'g1', '乡勇', 1, 7)");
    await client.query("INSERT INTO army_units VALUES ('dup3', 'g2', '弓手', 2, 3)");

    // 运行迁移
    await ensureArmyUnitsConstraint(client);

    // 约束已补齐
    const con = await client.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = $1 AND conrelid = 'army_units'::regclass`,
      ['army_units_general_id_soldier_level_key'],
    );
    assert.equal(con.rowCount, 1, '迁移后应存在 UNIQUE (general_id, soldier_level) 约束');

    // 重复行已合并：g1/乡勇 求和为 12，g2/弓手 无重复保持不变
    const dup = await client.query('SELECT count FROM army_units WHERE general_id = $1 AND soldier_level = 1', ['g1']);
    assert.equal(dup.rowCount, 1, '重复的 (g1,1) 应只剩一行');
    assert.equal(dup.rows[0].count, 12, '数量应合并为 5+7=12');
    const uniq = await client.query('SELECT count FROM army_units WHERE general_id = $1 AND soldier_level = 2', ['g2']);
    assert.equal(uniq.rowCount, 1, '无重复的 (g2,2) 应保持不变');
    assert.equal(uniq.rows[0].count, 3);

    // 修复后 ON CONFLICT 合并不再抛错（原 bug：缺约束时运行时抛错）
    await client.query(
      `INSERT INTO army_units (id, general_id, soldier_type, soldier_level, count)
       VALUES ($1, 'g1', '乡勇', 1, 3)
       ON CONFLICT (general_id, soldier_level)
       DO UPDATE SET count = army_units.count + EXCLUDED.count`,
      [randomUUID()],
    );
    const after = await client.query('SELECT count FROM army_units WHERE general_id = $1 AND soldier_level = 1', ['g1']);
    assert.equal(after.rows[0].count, 15, 'ON CONFLICT 应合并为 12+3=15');

    // 幂等：重复运行不报错、约束仍在
    await ensureArmyUnitsConstraint(client);
    const con2 = await client.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = $1 AND conrelid = 'army_units'::regclass`,
      ['army_units_general_id_soldier_level_key'],
    );
    assert.equal(con2.rowCount, 1, '幂等运行后约束应仍在');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('迁移：旧库 marches 缺部分唯一索引且有重复 active 时先去重再建索引（幂等）', { skip }, async () => {
  // 先确保当前 schema 就位（marches 表与索引已存在），再在事务里模拟旧库并回滚，避免污染持久数据
  await ensureSchema(db);
  const client = await db.connect();
  await client.query('BEGIN');
  try {
    // 模拟旧库：marches 缺「同一武将单条 active」部分唯一索引（摘掉它），且存在竞态遗留的重复 active 行军
    await client.query('DROP INDEX IF EXISTS marches_general_id_active_unique');
    await client.query("INSERT INTO users (id, username, password_hash) VALUES ('mig-u', 'mig_u', 'x')");
    await client.query("INSERT INTO worlds (id, name, width, height, seed) VALUES ('mig-w', 'w', 10, 10, 1)");
    await client.query(
      "INSERT INTO generals (id, user_id, name, level, world_id, x, y) VALUES ('mig-g1', 'mig-u', 'g1', 1, 'mig-w', 0, 0), ('mig-g2', 'mig-u', 'g2', 1, 'mig-w', 0, 0)",
    );
    // g1 有两条 active（出发时间不同）+ 一条已 cancelled；g2 只有一条 active
    await client.query(
      `INSERT INTO marches (id, world_id, general_id, user_id, origin_x, origin_y, target_x, target_y, departed_at, arrives_at, status)
       VALUES
         ('m1', 'mig-w', 'mig-g1', 'mig-u', 0, 0, 1, 1, '2024-01-01 10:00:00+00', now() + interval '1 hour', 'active'),
         ('m2', 'mig-w', 'mig-g1', 'mig-u', 0, 0, 2, 2, '2024-01-01 11:00:00+00', now() + interval '1 hour', 'active'),
         ('m3', 'mig-w', 'mig-g1', 'mig-u', 0, 0, 3, 3, '2024-01-01 12:00:00+00', now() + interval '1 hour', 'cancelled'),
         ('m4', 'mig-w', 'mig-g2', 'mig-u', 0, 0, 4, 4, '2024-01-01 10:00:00+00', now() + interval '1 hour', 'active')`,
    );

    // 运行迁移（旧代码会因重复 active 直接在建索引时报错）
    await ensureMarchActiveUnique(client);

    // 部分唯一索引已补齐
    const idx = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'marches_general_id_active_unique'`,
    );
    assert.equal(idx.rowCount, 1, '迁移后应存在 marches 部分唯一索引');

    // g1 只保留一条 active（出发最早的一条 m1），其余被取消
    const g1Active = await client.query(
      `SELECT id FROM marches WHERE general_id = 'mig-g1' AND status = 'active' ORDER BY departed_at`,
    );
    assert.equal(g1Active.rowCount, 1, 'g1 的 active 行军应只剩一条');
    assert.equal(g1Active.rows[0].id, 'm1', '应保留出发最早的一条 active 行军');

    const m2 = await client.query(`SELECT status, cancelled_at FROM marches WHERE id = 'm2'`);
    assert.equal(m2.rows[0].status, 'cancelled', '重复的 m2 应被取消');
    assert.ok(m2.rows[0].cancelled_at, '被取消的 m2 应写入 cancelled_at');

    // 原本已 cancelled 的 m3 保持不变，g2 的 m4 不受影响
    const m3 = await client.query(`SELECT status FROM marches WHERE id = 'm3'`);
    assert.equal(m3.rows[0].status, 'cancelled');
    const g2Active = await client.query(`SELECT count(*)::int AS n FROM marches WHERE general_id = 'mig-g2' AND status = 'active'`);
    assert.equal(g2Active.rows[0].n, 1, 'g2 的单条 active 行军不应被误删');

    // 幂等：重复运行不报错、索引仍在、active 仍各只有一条
    await ensureMarchActiveUnique(client);
    const idx2 = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'marches_general_id_active_unique'`,
    );
    assert.equal(idx2.rowCount, 1, '幂等运行后索引应仍在');
    const g1Active2 = await client.query(
      `SELECT count(*)::int AS n FROM marches WHERE general_id = 'mig-g1' AND status = 'active'`,
    );
    assert.equal(g1Active2.rows[0].n, 1, '幂等运行后 g1 仍只有一条 active 行军');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
