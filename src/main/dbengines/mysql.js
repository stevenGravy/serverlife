'use strict';
/**
 * MySQL, either over a `tsh proxy db --tunnel` port (no password — same
 * trust model as postgres.js) or a direct connection with a real one.
 */

const mysql = require('mysql2/promise');

async function withConn({ host, port }, opts, fn) {
  const conn = await mysql.createConnection({
    host, port, user: opts?.dbUser, password: opts?.password || '',
    database: opts?.dbNameParam || undefined,
    ssl: opts?.ssl || undefined,
    connectTimeout: 8000,
  });
  try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}

async function testConnection(target, opts) {
  try {
    const [rows] = await withConn(target, opts, (conn) =>
      conn.query('select current_user() as currentUser, version() as version'));
    return { ok: true, currentUser: rows[0].currentUser, version: rows[0].version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * databases -> tables -> columns, via information_schema.
 *
 * MySQL's information_schema echoes column names in its own catalog case
 * (TABLE_SCHEMA, not table_schema) regardless of how the query is written
 * — confirmed directly, this silently broke every field access below until
 * each one was given an explicit lowercase alias, which *is* honored as-is.
 */
async function listSchema(target, opts) {
  return withConn(target, opts, async (conn) => {
    const [tables] = await conn.query(`
      select table_schema as table_schema, table_name as table_name, table_type as table_type
      from information_schema.tables
      where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
      order by table_schema, table_name`);
    const [cols] = await conn.query(`
      select table_schema as table_schema, table_name as table_name,
             column_name as column_name, data_type as data_type
      from information_schema.columns
      where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
      order by table_schema, table_name, ordinal_position`);
    const colsByTable = new Map();
    for (const c of cols) {
      const key = `${c.table_schema}.${c.table_name}`;
      if (!colsByTable.has(key)) colsByTable.set(key, []);
      colsByTable.get(key).push({ name: c.column_name, type: c.data_type });
    }
    const bySchema = new Map();
    for (const t of tables) {
      if (!bySchema.has(t.table_schema)) bySchema.set(t.table_schema, []);
      bySchema.get(t.table_schema).push({
        name: t.table_name,
        kind: t.table_type === 'VIEW' ? 'view' : 'table',
        columns: colsByTable.get(`${t.table_schema}.${t.table_name}`) || [],
      });
    }
    return [...bySchema.entries()].map(([schema, schemaTables]) => ({ schema, tables: schemaTables }));
  });
}

async function runQuery(target, opts, text) {
  try {
    return await withConn(target, opts, async (conn) => {
      const [rows, fields] = await conn.query(text);
      if (!Array.isArray(rows)) {
        // INSERT/UPDATE/DDL etc. return a ResultSetHeader, not a row array.
        return { ok: true, columns: [], rows: [], rowCount: rows.affectedRows ?? 0 };
      }
      return { ok: true, columns: (fields || []).map((f) => f.name), rows, rowCount: rows.length };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { testConnection, listSchema, runQuery };
