#!/usr/bin/env node
/**
 * WMS users check: every user declared in local-users.json with `inDatabase !== false` must
 * exist in the WMS `User` table. Exit 0 when they all do; otherwise print the missing emails
 * and exit 1. Run with the WMS backend repo as cwd (to resolve `pg`) and DATABASE_URL set.
 *
 *   node check-users.mjs <local-users.json>
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv[2];
const { Client } = createRequire(join(process.cwd(), 'package.json'))('pg');
const schema = (process.env.DB_SCHEMA || 'wms_app').replace(/"/g, '');

const expected = JSON.parse(readFileSync(file, 'utf8')).users
  .filter((u) => u.inDatabase !== false)
  .map((u) => u.email.toLowerCase());

const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const { rows } = await client.query(
    `SELECT lower(email) AS email FROM "${schema}"."User" WHERE lower(email) = ANY($1)`,
    [expected],
  );
  const found = new Set(rows.map((r) => r.email));
  const missing = expected.filter((e) => !found.has(e));
  if (missing.length) {
    console.log(`wms: missing in the database: ${missing.join(', ')}`);
    console.log('Run "wms-seed" in Tilt.');
    process.exit(1);
  }
  console.log(`wms: ${expected.length} declared users present.`);
} catch (e) {
  console.log(`wms: cannot check users: ${e.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
