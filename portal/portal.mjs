/**
 * Local AgroBayer portal: the load balancer + auth-host of the cloud, in one process.
 *
 * Module-agnostic version of the `tools/portal-local.mjs` that each module carried. It plays
 * the edge for EVERY selected module on one origin (localhost:8080):
 *
 *   /{module}/*                         → that module's entry process (HTTP + websockets)
 *   /api/auth/*, /api/shell/nav         → answered here, same contract as the auth-host
 *   /.well-known/jwks.json              → public key the modules verify sessions with
 *   /tokens.css                         → fetched from the dev portal
 *
 * Sessions are real Ed25519 JWTs (iss = aud = this origin), signed with a key generated in
 * memory at startup that dies with the process. Modules verify them exactly like in GCP.
 * One cookie (`agrobayer_session`, Path=/) serves every module, like the real SSO.
 *
 * Configuration comes from the root Tiltfile through env vars:
 *   AGB_ROUTES     [{id, label, path, port, gated}]
 *   AGB_USERS      [{module, file}]  → each module's local-users.json
 *   AGB_STATE_DIR  where lib/run-check.mjs records each module's users check
 *   AGB_RUN_ID     only checks of this run count
 *
 * A `gated` module is mounted only after its users check passed in this run. Until then its
 * route answers with an explanation and its users are not offered (spec: block only the
 * module that fails).
 *
 * Not reproduced: Gigya, identity-api permissions, WAF, rate limit.
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { generateKeyPairSync, sign, verify, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORTAL_PORT ?? 8080);
const ISSUER = `http://localhost:${PORT}`;
const COOKIE = 'agrobayer_session';
const TOKENS_ORIGIN = process.env.AGB_PORTAL_ORIGIN ?? 'https://app-np.agroeva.ai';
const STATE_DIR = process.env.AGB_STATE_DIR ?? '';
const RUN_ID = process.env.AGB_RUN_ID ?? '';
const KID = 'local-1';
const TTL_SECONDS = 8 * 60 * 60;
const TILT_UI = 'http://localhost:10350';

const ROUTES = JSON.parse(process.env.AGB_ROUTES ?? '[]');
const USER_SOURCES = JSON.parse(process.env.AGB_USERS ?? '[]');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'EdDSA', use: 'sig', kid: KID };

// ─── Module state ────────────────────────────────────────────────────────────

/** 'ok' | 'pending' | 'blocked', plus the check output. Read per request: it changes live. */
function moduleState(id) {
  const r = ROUTES.find((x) => x.id === id);
  if (r && !r.gated) return { status: 'ok', detail: '' };
  try {
    const s = JSON.parse(readFileSync(join(STATE_DIR, `${id}.json`), 'utf8'));
    if (s.runId !== RUN_ID) return { status: 'pending', detail: 'El chequeo de usuarios todavía no corrió.' };
    return { status: s.status, detail: s.detail ?? '' };
  } catch {
    return { status: 'pending', detail: 'El chequeo de usuarios todavía no corrió.' };
  }
}

const isOpen = (id) => moduleState(id).status === 'ok';

// ─── Users: merged by email across the selected modules ──────────────────────

/**
 * Same email declared by two modules = one person with both. `modules` and `scope` are merged;
 * for scalar claims (role, tipo, name) the first declaration wins and the conflict is logged.
 */
function loadUsers() {
  const byEmail = new Map();
  for (const { module, file } of USER_SOURCES) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`  !! ${module}: cannot read ${file}: ${e.message}`);
      continue;
    }
    for (const u of doc.users ?? []) {
      const email = String(u.email ?? '').toLowerCase();
      if (!email) continue;
      const prev = byEmail.get(email);
      if (!prev) {
        byEmail.set(email, { ...u, email, sources: [module] });
        continue;
      }
      for (const k of ['name', 'tipo', 'role']) {
        if (u[k] !== undefined && prev[k] !== undefined && u[k] !== prev[k]) {
          console.warn(`  !! ${email}: "${k}" differs between ${prev.sources.join(', ')} and ${module}; using "${prev[k]}"`);
        }
        if (prev[k] === undefined && u[k] !== undefined) prev[k] = u[k];
      }
      prev.modules = [...new Set([...(prev.modules ?? []), ...(u.modules ?? [])])];
      prev.claims = {
        ...(prev.claims ?? {}),
        ...(u.claims ?? {}),
        scope: { ...(prev.claims?.scope ?? {}), ...(u.claims?.scope ?? {}) },
      };
      prev.sources.push(module);
      prev.note = [prev.note, u.note].filter(Boolean).join(' · ');
    }
  }
  return [...byEmail.values()];
}

const USERS = loadUsers();
const visibleUsers = () => USERS.filter((u) => u.sources.some(isOpen));
const userKey = (u) => createHash('sha256').update(u.email).digest('hex').slice(0, 12);

// ─── EdDSA JWT with node:crypto ──────────────────────────────────────────────

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function signSession(u) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...(u.claims ?? {}),
    sub: u.sub ?? `u-${userKey(u)}`,
    email: u.email,
    name: u.name ?? u.email,
    tipo: u.tipo ?? 'interno',
    ...(u.role ? { role: u.role } : {}),
    modules: u.modules ?? [],
    tid: randomUUID(),
    iat: now,
    exp: now + TTL_SECONDS,
    iss: ISSUER,
    aud: ISSUER,
  };
  if (payload.scope && Object.keys(payload.scope).length === 0) delete payload.scope;
  const input = `${b64url({ alg: 'EdDSA', typ: 'JWT', kid: KID })}.${b64url(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

function session(req) {
  const token = (req.headers.cookie ?? '').split(';')
    .map((p) => p.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    if (!verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (payload.iss !== ISSUER || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const html = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

const initials = (n) => n.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const routeFor = (path) =>
  ROUTES.find((r) => path === r.path || path.startsWith(`${r.path}/`));

/** Where to land after login: /inicio when it runs, else the first open module. */
function defaultTarget() {
  const inicio = ROUTES.find((r) => r.id === 'inicio' && isOpen(r.id));
  const first = inicio ?? ROUTES.find((r) => isOpen(r.id));
  return first ? `${first.path}/` : '/';
}

/** Only paths of this same origin: no `//other-site` nor absolute URLs. */
const safeNext = (next) =>
  typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : defaultTarget();

/**
 * Transparent forward to the module. Keeps the portal Host and adds `x-forwarded-*`, so the
 * redirects the module builds point to :8080, like behind the load balancer.
 */
function forward(route, req, res) {
  const p = httpRequest(
    {
      hostname: 'localhost', port: route.port, path: req.url, method: req.method,
      headers: { ...req.headers, 'x-forwarded-host': req.headers.host ?? `localhost:${PORT}`, 'x-forwarded-proto': 'http' },
    },
    (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
  );
  p.on('error', () => html(res, 502, page('Arrancando…', `
    <p>El módulo <code>${esc(route.id)}</code> todavía no responde en <code>localhost:${route.port}</code>.</p>
    <p>Si recién levantaste todo, esperá unos segundos. Si sigue así, mirá su log en
    <a href="${TILT_UI}">Tilt</a>.</p>`)));
  req.pipe(p);
}

/** Websockets (hot reload of Next and Vite). */
function forwardUpgrade(route, req, socket, head) {
  const p = httpRequest({ hostname: 'localhost', port: route.port, path: req.url, method: req.method, headers: req.headers });
  p.on('upgrade', (r, upstream, upstreamHead) => {
    const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  p.on('error', () => socket.destroy());
  p.end();
}

/** The brand sheet comes from the real dev portal. If it fails, modules render unframed. */
function forwardTokens(res) {
  const u = new URL('/tokens.css', TOKENS_ORIGIN);
  const fail = (why) => console.error(`  !! tokens.css: ${why} (origin ${TOKENS_ORIGIN}). Modules will render without the portal frame.`);
  httpsRequest({ hostname: u.hostname, path: u.pathname }, (r) => {
    if ((r.statusCode ?? 502) >= 400) fail(`the portal answered ${r.statusCode}`);
    res.writeHead(r.statusCode ?? 502, { 'content-type': 'text/css' });
    r.pipe(res);
  }).on('error', (e) => {
    fail(e.message);
    res.writeHead(502).end('/* tokens.css could not be fetched from the portal */');
  }).end();
}

// ─── Pages ───────────────────────────────────────────────────────────────────

const page = (title, body) => `<!doctype html><meta charset="utf-8">
<title>${esc(title)} · Portal local</title>
<link rel="stylesheet" href="/tokens.css">
<div style="font-family:var(--agb-font-sans,system-ui);max-width:760px;margin:48px auto;padding:0 20px">
<h1 style="color:var(--agb-color-primary)">${esc(title)}</h1>${body}</div>`;

const STATUS_LABEL = { ok: 'montado', pending: 'esperando chequeo', blocked: 'bloqueado' };

function home(current, next) {
  const modules = ROUTES.map((r) => {
    const s = moduleState(r.id);
    const link = s.status === 'ok' ? `<a href="${esc(r.path)}/">${esc(r.label)}</a>` : esc(r.label);
    const why = s.status === 'blocked' ? `<pre style="white-space:pre-wrap;color:var(--agb-color-text-muted)">${esc(s.detail)}</pre>` : '';
    return `<li>${link} <code>${esc(r.path)}</code> · ${STATUS_LABEL[s.status] ?? s.status}${why}</li>`;
  }).join('\n');
  const users = visibleUsers().map((u) => `<li><a href="/api/auth/login?as=${userKey(u)}&next=${encodeURIComponent(next)}"><strong>${esc(u.name ?? u.email)}</strong></a>
    — <code>${esc(u.email)}</code> · ${esc(u.sources.join(', '))}${u.note ? ` · ${esc(u.note)}` : ''}</li>`).join('\n');
  return page('Portal local', `
<p>Sesión actual: <strong>${current ? `${esc(current.name)} &lt;${esc(current.email)}&gt;` : 'ninguna'}</strong>
${current ? ' · <a href="/api/auth/logout-link">cerrar sesión</a>' : ''}</p>
<h2 style="font-size:16px">Módulos</h2><ul style="line-height:1.9">${modules}</ul>
<h2 style="font-size:16px">Entrar como…</h2>
<ul style="line-height:1.9">${users || '<li>Ningún módulo montado todavía: mirá <a href="' + TILT_UI + '">Tilt</a>.</li>'}</ul>`);
}

function blockedPage(route) {
  const s = moduleState(route.id);
  const title = s.status === 'blocked' ? `${route.label} está bloqueado` : `${route.label} todavía no está montado`;
  return page(title, `
<p>El módulo <code>${esc(route.id)}</code> se monta cuando todos los usuarios que declara existen en su base.</p>
<pre style="white-space:pre-wrap">${esc(s.detail)}</pre>
<p>Para resolverlo: en <a href="${TILT_UI}">Tilt</a>, corré el seed del módulo y después
<code>${esc(route.id)}-users-check</code>. Esta página se actualiza sola cuando pase.</p>
<p><a href="/">Volver al portal</a></p>
<script>setTimeout(() => location.reload(), 5000)</script>`);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  const path = url.pathname;

  if (path === '/healthz') return json(res, 200, { ok: true });
  if (path === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });
  if (path === '/tokens.css') return forwardTokens(res);

  if (path === '/api/auth/login') {
    const next = safeNext(url.searchParams.get('next'));
    const who = url.searchParams.get('as');
    // Without `as` (a module's middleware sends people here) the user is picked on the home page.
    if (!who) {
      res.writeHead(302, { location: `/?next=${encodeURIComponent(next)}` });
      return res.end();
    }
    const u = visibleUsers().find((x) => userKey(x) === who);
    if (!u) return json(res, 400, { error: `Unknown or unavailable user: ${who}` });
    res.writeHead(302, {
      'set-cookie': `${COOKIE}=${signSession(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}`,
      location: next,
    });
    return res.end();
  }

  if (path === '/api/auth/logout' || path === '/api/auth/logout-link') {
    const isLink = path.endsWith('-link');
    res.writeHead(isLink ? 302 : 200, {
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
      ...(isLink ? { location: '/' } : { 'content-type': 'application/json' }),
    });
    return res.end(isLink ? '' : '{"ok":true}');
  }

  if (path === '/api/auth/me') {
    const s = session(req);
    if (!s) return json(res, 401, { authenticated: false, loginUrl: `/api/auth/login?next=${defaultTarget()}` });
    return json(res, 200, {
      authenticated: true,
      user: { email: s.email, name: s.name, initials: initials(s.name) },
      role: s.role, tipo: s.tipo, modules: s.modules, expiresAt: s.exp, traceId: s.tid,
    });
  }

  if (path === '/api/shell/nav') {
    const s = session(req);
    if (!s) return json(res, 401, { error: { code: 'unauthenticated', message: 'Sesión requerida', traceId: '' } });
    return json(res, 200, {
      user: { email: s.email, name: s.name, initials: initials(s.name), tipo: s.tipo },
      // Filtered on the server: only open modules that the session carries.
      items: ROUTES
        .filter((r) => s.modules.includes(r.id) && isOpen(r.id))
        .map((r) => ({ id: r.id, label: r.label, href: r.path, type: 'module' })),
      traceId: s.tid,
    });
  }

  const route = routeFor(path);
  if (route) return isOpen(route.id) ? forward(route, req, res) : html(res, 503, blockedPage(route));

  if (path === '/' || path === '/inicio' || path === '/inicio/') {
    return html(res, 200, home(session(req), safeNext(url.searchParams.get('next'))));
  }

  return html(res, 404, page('Acá no hay nada', `
<p>Se pidió <code>${esc(path)}</code> y no hay ningún módulo levantado en esa ruta.</p>
<p><a href="/">Volver al portal</a></p>`));
});

server.on('upgrade', (req, socket, head) => {
  const route = routeFor(new URL(req.url ?? '/', ISSUER).pathname);
  if (route && isOpen(route.id)) return forwardUpgrade(route, req, socket, head);
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`portal  → ${ISSUER}`);
  for (const r of ROUTES) console.log(`  ${r.path.padEnd(14)} → localhost:${r.port}${r.gated ? '  (gated by users check)' : ''}`);
  console.log(`users   → ${USERS.length} from ${[...new Set(USER_SOURCES.map((s) => s.module))].join(', ') || 'no module'}`);
});
