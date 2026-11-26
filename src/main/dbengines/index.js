'use strict';
/**
 * One query-runner adapter per Teleport database protocol — `testConnection`/
 * `listSchema`/`runQuery`, each taking the local tunnel port `dbproxy.js`
 * already has open. New engines (mongodb, redis, cassandra, sqlserver)
 * add a sibling module and a line here, nothing else.
 */

const postgres = require('./postgres');
const mysql = require('./mysql');

const ADAPTERS = { postgres, mysql };

function forProtocol(protocol) {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new Error(`No query runner for "${protocol}" yet.`);
  return adapter;
}

module.exports = { forProtocol, ADAPTERS };
