#!/usr/bin/env node
/**
 * Runs a module's users check and records the outcome for the portal.
 *
 *   node lib/run-check.mjs <stateDir> <runId> <module> -- <check command...>
 *
 * The module's check knows nothing about the portal: it only exits 0 (every declared user
 * exists in its database) or non-zero, printing what is missing. This wrapper writes
 * `<stateDir>/<module>.json` so the portal mounts the module only after a passing check of
 * THIS run (`runId`); a stale "ok" from a previous run is ignored by the portal.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [stateDir, runId, module] = argv.slice(0, sep);
const command = argv.slice(sep + 1);
if (sep < 0 || !stateDir || !runId || !module || command.length === 0) {
  console.error('Usage: node lib/run-check.mjs <stateDir> <runId> <module> -- <command...>');
  process.exit(2);
}

mkdirSync(stateDir, { recursive: true });
const write = (status, detail) =>
  writeFileSync(
    join(stateDir, `${module}.json`),
    JSON.stringify({ runId, module, status, detail, at: new Date().toISOString() }, null, 2),
  );

write('pending', 'Users check running.');

const [bin, ...args] = command;
// `node` runs through this same binary; anything else (pnpm, npx: .cmd shims on Windows)
// needs a shell there to be found.
const isNode = bin === 'node';
const r = spawnSync(isNode ? process.execPath : bin, args, {
  encoding: 'utf8',
  shell: !isNode && process.platform === 'win32',
});
const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
if (output) console.log(output);

if (r.status === 0) {
  write('ok', output || 'Every declared user exists.');
  process.exit(0);
}
write('blocked', output || `The check exited with code ${r.status ?? r.error?.message}.`);
process.exit(1);
