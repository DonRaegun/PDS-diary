'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../db');
const contract = require('../contracts/pds-schema-v2.json');

test('contracts/pds-schema-v2.json이 실제 DB 표·항목과 같다', () => {
  const db = open(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
  assert.deepEqual(Object.keys(contract.tables).sort(), names);
  for (const n of names) {
    const cols = db.prepare(`PRAGMA table_info(${n})`).all().map((c) => c.name);
    assert.deepEqual(contract.tables[n].columns.map((c) => c.name), cols, n);
  }
});
