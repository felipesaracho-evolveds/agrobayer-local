#!/usr/bin/env node
/**
 * AgroBayer local runner: one command to run any set of modules like they run in GCP.
 *
 *   node agb.mjs                 → lists the modules found and asks which ones to start
 *   node agb.mjs wms gestion     → starts those modules (still asks before a heavy start)
 *   node agb.mjs wms --yes       → no questions
 *
 * Discovery: every `agrobayer-*` folder next to this one that declares itself with an
 * `agb-local.star` (in the repo, or in `overlays/<repo>/` while a repo has none). Repos are
 * grouped by the MODULE they declare, never by folder name: `-backend`/`-frontend` pairs and
 * single repos end up as one module each. Repos without a declaration are not modules for
 * this runner (infra, platform, shell, templates...).
 *
 * Then it writes `.agb/selection.json`, runs `tilt up` (Tilt reads that file) and, when you
 * press Ctrl+C, `tilt down` so the Postgres containers stop too. Their data stays in volumes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(process.env.AGB_WORKSPACE ?? join(ROOT, '..'));
const DECLARATION = 'agb-local.star';
const posix = (p) => p.replaceAll('\\', '/');

// ─── Discovery ───────────────────────────────────────────────────────────────

function discover() {
  const modules = new Map();
  for (const entry of readdirSync(WORKSPACE, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('agrobayer-') || entry.name === 'agrobayer-local') continue;
    const repo = join(WORKSPACE, entry.name);
    const own = join(repo, DECLARATION);
    const overlay = join(ROOT, 'overlays', entry.name, DECLARATION);
    const star = existsSync(own) ? own : existsSync(overlay) ? overlay : null;
    if (!star) continue;

    const text = readFileSync(star, 'utf8');
    const id = /^MODULE\s*=\s*"([a-z0-9-]+)"/m.exec(text)?.[1];
    if (!id) {
      console.warn(`  !! ${entry.name}: ${DECLARATION} has no MODULE = "..." line, skipped.`);
      continue;
    }
    const m = modules.get(id) ?? { id, repos: [], processes: 0, postgres: new Set() };
    m.repos.push({ name: entry.name, repo, star, overlay: star === overlay });
    m.processes += (text.match(/agb\.process\(/g) ?? []).length;
    for (const [, v] of text.matchAll(/postgres\s*=\s*"(\d+)"/g)) m.postgres.add(v);
    modules.set(id, m);
  }
  return [...modules.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const describe = (m) =>
  `${m.id.padEnd(14)} ${m.processes} proceso(s)${m.postgres.size ? ` · Postgres ${[...m.postgres].join(', ')}` : ''}` +
  `   [${m.repos.map((r) => r.name + (r.overlay ? '*' : '')).join(', ')}]`;

// ─── Selection ───────────────────────────────────────────────────────────────

// Reads through the line iterator instead of rl.question(): it buffers lines, so answers
// piped in all at once (scripts, CI) are not lost, and a closed stdin reads as "".
let lines;
async function ask(rl, question) {
  lines ??= rl[Symbol.asyncIterator]();
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? '' : value.trim();
}

async function pick(found, wanted, rl) {
  if (wanted.length) {
    const unknown = wanted.filter((w) => !found.some((m) => m.id === w));
    if (unknown.length) {
      console.error(`Módulos desconocidos: ${unknown.join(', ')}. Disponibles: ${found.map((m) => m.id).join(', ')}`);
      process.exit(1);
    }
    return found.filter((m) => wanted.includes(m.id));
  }
  console.log('\nMódulos disponibles (* = declaración en overlays/ del runner):\n');
  found.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}) ${describe(m)}`));
  const answer = await ask(rl, '\nElegí los módulos (números separados por coma, o "todos"): ');
  if (answer.toLowerCase() === 'todos') return found;
  const idx = [...new Set(answer.split(/[\s,]+/).filter(Boolean).map(Number))];
  if (!idx.length || idx.some((n) => !Number.isInteger(n) || n < 1 || n > found.length)) {
    console.error('Selección inválida.');
    process.exit(1);
  }
  return idx.map((n) => found[n - 1]);
}

// ─── Preflight ───────────────────────────────────────────────────────────────

function preflight(selected) {
  const problems = [];
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' }).status;
  if (run('tilt', ['version']) !== 0) {
    problems.push('No se encontró `tilt`. Instalalo y abrí una terminal nueva.');
  }
  // Docker only matters when a selected module needs Postgres.
  if (selected.some((m) => m.postgres.size)) {
    if (run('docker', ['--version']) !== 0) {
      problems.push('No se encontró `docker`. Instalá Docker Desktop y abrí una terminal nueva.');
    } else if (run('docker', ['info']) !== 0) {
      problems.push('Docker está instalado pero el motor no responde: abrí Docker Desktop y esperá que arranque.');
    }
  }
  for (const m of selected) {
    for (const r of m.repos) {
      if (existsSync(join(r.repo, 'package.json')) && !existsSync(join(r.repo, 'node_modules'))) {
        problems.push(`${r.name}: falta node_modules (corré la instalación de dependencias en ese repo).`);
      }
    }
  }
  return problems;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const wanted = args.filter((a) => !a.startsWith('-'));

const found = discover();
if (!found.length) {
  console.error(`No hay módulos con ${DECLARATION} en ${WORKSPACE}.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const selected = await pick(found, wanted, rl);

if (selected.length > 1 && !yes) {
  const processes = selected.reduce((n, m) => n + m.processes, 0);
  const pg = new Set(selected.flatMap((m) => [...m.postgres]));
  console.log(`\n  Aviso: vas a levantar ${selected.length} módulos: ${processes} procesos nativos` +
    `${pg.size ? ` + ${pg.size} Postgres en Docker (${[...pg].map((v) => `pg${v}`).join(', ')})` : ''} + el portal.`);
  console.log('  Varios dev servers juntos pueden consumir bastante RAM y CPU.');
  const ok = await ask(rl, '  ¿Seguimos? (s/N): ');
  if (!/^s(i|í)?$/i.test(ok)) {
    console.log('Cancelado.');
    process.exit(0);
  }
}
rl.close();

const problems = preflight(selected);
if (problems.length) {
  console.error('\nNo se puede arrancar:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

const runId = `${Date.now().toString(36)}-${process.pid}`;
mkdirSync(join(ROOT, '.agb'), { recursive: true });
writeFileSync(join(ROOT, '.agb', 'selection.json'), JSON.stringify({
  runId,
  repos: selected.flatMap((m) => m.repos.map((r) => ({
    module: m.id,
    name: r.name,
    repo: posix(r.repo),
    star: posix(r.star),
    here: posix(dirname(r.star)),
  }))),
}, null, 2));

console.log(`\nLevantando: ${selected.map((m) => m.id).join(', ')}`);
console.log('  Portal:  http://localhost:8080');
console.log('  Tilt:    http://localhost:10350   (logs, estado y botones de seed)');
console.log('  Ctrl+C apaga todo.\n');

// Ctrl+C reaches Tilt too (same console); we only wait for it and then clean up.
process.on('SIGINT', () => {});
const tilt = spawn('tilt', ['up', '--file', join(ROOT, 'Tiltfile')], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
tilt.on('exit', () => {
  console.log('\nApagando contenedores (los datos quedan en sus volúmenes)...');
  spawnSync('tilt', ['down', '--file', join(ROOT, 'Tiltfile')], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(0);
});
