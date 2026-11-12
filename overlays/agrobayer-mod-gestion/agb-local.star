# Local declaration of agrobayer-mod-gestion (final home: the root of that repo).
# MODULE is read by agb.mjs without running Starlark: keep it a plain string literal.
#
# No Postgres: gestion reads BigQuery, so it needs `gcloud auth application-default login`
# and GCP_PROJECT_ID in its .env. Without a database there is no users check either.
MODULE = "gestion"


def register(agb, ctx):
    # The API refuses to start without src/hub/web/dist/index.html, even in development.
    agb.task(MODULE, "gestion-web-build", dir=ctx.repo, cmd="npm --prefix src/hub/web run build")
    agb.process(
        MODULE,
        "gestion-api",
        dir=ctx.repo,
        cmd="npm run dev:api",
        port=3002,
        env={
            "PORT": "3002",
            # The only required var of its config. Dev project unless the shell sets another.
            "GCP_PROJECT_ID": os.getenv("GCP_PROJECT_ID", "agroeva-mod-gestion-dev"),
        },
        deps=["gestion-web-build"],
    )
    # Vite serves the SPA with hot reload and forwards /gestion/api to the API on 3002.
    agb.process(MODULE, "gestion-web", dir=ctx.repo, cmd="npm run dev:web", port=5173, deps=["gestion-api"])
    agb.route(MODULE, label="Gestión de Negocios", port=5173)
    agb.users(MODULE, file=ctx.here + "/local-users.json")
