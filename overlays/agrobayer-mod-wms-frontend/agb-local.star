# Local declaration of agrobayer-mod-wms-frontend (final home: the root of that repo).
# MODULE is read by agb.mjs without running Starlark: keep it a plain string literal.
MODULE = "wms"


def register(agb, ctx):
    agb.process(
        MODULE,
        "wms-frontend",
        dir=ctx.repo,
        cmd="pnpm run dev",
        port=3000,
        env={
            "PORT": "3000",
            "AGB_BASE_PATH": "/wms",
            "WMS_API_URL": "http://localhost:8081",
        },
        deps=["wms-backend"],
    )
    agb.route(MODULE, label="WMS", port=3000)
