import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { ensureSchema, ensureArmyUnitsConstraint } from '../src/schema.js';

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
