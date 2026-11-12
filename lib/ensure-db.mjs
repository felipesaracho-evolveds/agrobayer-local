#!/usr/bin/env node
/**
 * Creates a module database inside a Postgres container if it does not exist yet.
 *
 *   node lib/ensure-db.mjs <container> <database>
 *
 * Talks to the container through `docker exec`, so it needs no Postgres client on the host.
 * Waits for the server to accept connections first: the container can be "running" before
 * Postgres finishes its first initialization.
 */
import { spawnSync } from 'node:child_process';

const [container, database] = process.argv.slice(2);
if (!container || !database || !/^[a-z_][a-z0-9_]*$/.test(database)) {
  console.error('Usage: node lib/ensure-db.mjs <container> <database>  (database: [a-z0-9_])');
  process.exit(2);
}

const dockerExec = (...args) =>
  spawnSync('docker', ['exec', container, ...args], { encoding: 'utf8' });

const deadline = Date.now() + 90_000;
while (dockerExec('pg_isready', '-U', 'postgres').status !== 0) {
  if (Date.now() > deadline) {
    console.error(`Postgres in ${container} is not accepting connections after 90s.`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const exists = dockerExec(
  'psql', '-U', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
);
if (exists.status !== 0) {
  console.error(exists.stderr);
  process.exit(1);
}
if (exists.stdout.trim() === '1') {
  console.log(`Database "${database}" already exists in ${container}.`);
  process.exit(0);
}

const created = dockerExec('createdb', '-U', 'postgres', database);
if (created.status !== 0) {
  console.error(created.stderr);
  process.exit(1);
}
console.log(`Database "${database}" created in ${container}.`);
