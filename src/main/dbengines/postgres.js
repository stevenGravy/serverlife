'use strict';
/**
 * Postgres, either over a `tsh proxy db --tunnel` port or a direct
 * connection.
 *
 * Over the tunnel, trust-level auth already happened at the Teleport proxy
 * — confirmed directly against a real cluster, `select current_user`
 * answers as whichever `--db-user` the tunnel was started with — so
 * `opts.password` is left empty and the tunnel accepts that
 * unconditionally. A direct connection has no such tunnel: `opts.password`
 * is a real one, sent as-is, confirmed directly against a real Postgres
 * role with `scram-sha-256` auth.
 */

const { Client } = require('pg');

function clientFor({ host, port }, { dbUser, dbNameParam, password, ssl } = {}) {
  return new Client({
    host, port, user: dbUser, password: password || '',
    database: dbNameParam || dbUser, ssl: ssl || false,
    connectionTimeoutMillis: 8000,
  });
}

async function withClient(target, opts, fn) {
  const client = clientFor(target, opts);
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

async function testConnection(target, opts) {
  try {
    const row = await withClient(target, opts, async (client) => {
      const r = await client.query('select current_user as "currentUser", version() as "version"');
      return r.rows[0];
    });
    return { ok: true, currentUser: row.currentUser, version: row.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** schemas -> tables/views -> columns, via information_schema. */
async function listSchema(target, opts) {
  return withClient(target, opts, async (client) => {
    const tables = await client.query(`
      select table_schema, table_name, table_type
      from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name`);
    const cols = await client.query(`
      select table_schema, table_name, column_name, data_type
      from information_schema.columns
      where table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name, ordinal_position`);
    const colsByTable = new Map();
    for (const c of cols.rows) {
      const key = `${c.table_schema}.${c.table_name}`;
      if (!colsByTable.has(key)) colsByTable.set(key, []);
      colsByTable.get(key).push({ name: c.column_name, type: c.data_type });
    }
    const bySchema = new Map();
    for (const t of tables.rows) {
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
    return await withClient(target, opts, async (client) => {
      const r = await client.query(text);
      return {
        ok: true,
        columns: (r.fields || []).map((f) => f.name),
        rows: r.rows,
        rowCount: r.rowCount ?? r.rows.length,
      };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { testConnection, listSchema, runQuery };
