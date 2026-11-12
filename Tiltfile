# -*- mode: Python -*-
#
# Root Tiltfile of the AgroBayer local runner. Do not run `tilt up` directly: `node agb.mjs`
# discovers the module repos, lets you pick modules and writes `.agb/selection.json`, which is
# what this file reads.
#
# Module-agnostic on purpose: each repo declares its own processes in `agb-local.star`
# (during the PoC, in `overlays/<repo>/`). That file defines `register(agb, ctx)` and only
# calls the helpers below. Adding a module never touches this file.

ROOT = config.main_dir
STATE_DIR = os.path.join(ROOT, '.agb', 'state')
LIB = os.path.join(ROOT, 'lib')
PORTAL_PORT = 8080
ISSUER = 'http://localhost:%d' % PORTAL_PORT

selection = read_json(os.path.join(ROOT, '.agb', 'selection.json'), default={})
if not selection.get('repos'):
    fail('No modules selected. Start the stack with `node agb.mjs`, not `tilt up`.')
RUN_ID = selection['runId']

# Collected while the module declarations run; consumed at the end by Postgres and the portal.
_routes = []
_users = []
_gated = {}
_pg = {}


def _probe(port, path):
    if not port:
        return None
    if path != None:
        return probe(period_secs=2, http_get=http_get_action(port=port, path=path))
    return probe(period_secs=2, tcp_socket=tcp_socket_action(port=port))


def process(module, name, dir, cmd, port=None, env=None, deps=None, ready_path=None):
    """A long-running native process (dev server, API). Gets AGB_AUTH_ISSUER for free."""
    e = {'AGB_AUTH_ISSUER': ISSUER, 'AGB_MODULE_ID': module}
    e.update(env or {})
    local_resource(
        name,
        serve_cmd=cmd,
        serve_dir=dir,
        serve_env=e,
        resource_deps=deps or [],
        readiness_probe=_probe(port, ready_path),
        labels=[module],
    )


def task(module, name, dir, cmd, env=None, deps=None, manual=False):
    """A one-shot command: migrations run on start, seeds stay as a manual button."""
    local_resource(
        name,
        cmd=cmd,
        dir=dir,
        env=env or {},
        resource_deps=deps or [],
        labels=[module],
        auto_init=not manual,
        trigger_mode=TRIGGER_MODE_MANUAL if manual else TRIGGER_MODE_AUTO,
    )


def database(module, postgres, name=None):
    """A database for the module inside the shared container of its Postgres major version."""
    if postgres not in ['16', '17']:
        fail('%s: unsupported Postgres version "%s" (16 or 17)' % (module, postgres))
    _pg[postgres] = True
    db = name or module.replace('-', '_')
    resource = '%s-db' % module
    local_resource(
        resource,
        cmd=['node', os.path.join(LIB, 'ensure-db.mjs'), 'agb-pg' + postgres, db],
        resource_deps=['pg' + postgres],
        labels=[module],
    )
    return struct(
        resource=resource,
        url='postgresql://postgres:postgres@localhost:54%s/%s' % (postgres, db),
    )


def route(module, label, port, path=None):
    """Mounts the module under /{path} of the portal, the way the load balancer does."""
    _routes.append({'id': module, 'label': label, 'path': path or '/' + module, 'port': port})


def users(module, file, check=None, dir=None, env=None, deps=None):
    """Declares the module's test users. With `check`, the module stays hidden until it passes."""
    _users.append({'module': module, 'file': file})
    if check == None:
        return
    _gated[module] = True
    local_resource(
        '%s-users-check' % module,
        cmd=['node', os.path.join(LIB, 'run-check.mjs'), STATE_DIR, RUN_ID, module, '--'] + check,
        dir=dir,
        env=env or {},
        resource_deps=deps or [],
        labels=[module],
    )


agb = struct(
    process=process,
    task=task,
    database=database,
    route=route,
    users=users,
    issuer=ISSUER,
)

for repo in selection['repos']:
    declaration = load_dynamic(repo['star'])
    if 'register' not in declaration:
        fail('%s does not define register(agb, ctx)' % repo['star'])
    declaration['register'](agb, struct(repo=repo['repo'], here=repo['here'], module=repo['module']))

# --- Postgres: one container per major version actually needed ------------------------------
if _pg:
    docker_compose(
        [os.path.join(ROOT, 'postgres', 'pg%s.yml' % v) for v in sorted(_pg.keys())],
        project_name='agb-local',
        wait=True,
    )
    for v in _pg.keys():
        dc_resource('pg' + v, labels=['postgres'])

# --- Portal: the single entry point ---------------------------------------------------------
for r in _routes:
    r['gated'] = _gated.get(r['id'], False)

local_resource(
    'portal',
    serve_cmd=['node', os.path.join(ROOT, 'portal', 'portal.mjs')],
    serve_dir=ROOT,
    serve_env={
        'PORTAL_PORT': str(PORTAL_PORT),
        'AGB_ROUTES': str(encode_json(_routes)),
        'AGB_USERS': str(encode_json(_users)),
        'AGB_STATE_DIR': STATE_DIR,
        'AGB_RUN_ID': RUN_ID,
    },
    readiness_probe=_probe(PORTAL_PORT, '/healthz'),
    links=[link(ISSUER, 'Portal')],
    labels=['portal'],
)
