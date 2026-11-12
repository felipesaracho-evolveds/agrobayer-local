# Local declaration of agrobayer-mod-wms-backend (final home: the root of that repo).
# MODULE is read by agb.mjs without running Starlark: keep it a plain string literal.
MODULE = "wms"


def register(agb, ctx):
    db = agb.database(MODULE, postgres="17")
    env = {
        "DATABASE_URL": db.url,
        "DB_SCHEMA": "wms_app",
        # Empty on purpose: a value in the repo's .env would switch to the Cloud SQL connector.
        "CLOUD_SQL_INSTANCE": "",
        "DB_IMPERSONATE_SA": "",
    }
    users_file = ctx.here + "/local-users.json"

    agb.task(MODULE, "wms-migrate", dir=ctx.repo, cmd="npm run migrar", env=env, deps=[db.resource])
    agb.task(
        MODULE,
        "wms-seed",
        dir=ctx.repo,
        cmd="npm run db:seed && npx tsx scripts/seed-training.ts --reset && tilt trigger wms-users-check",
        env=env,
        deps=["wms-migrate"],
        manual=True,
    )
    agb.users(
        MODULE,
        file=users_file,
        check=["node", ctx.here + "/check-users.mjs", users_file],
        dir=ctx.repo,
        env=env,
        deps=["wms-migrate"],
    )
    agb.process(MODULE, "wms-backend", dir=ctx.repo, cmd="pnpm run dev", port=8081, env=env, deps=["wms-migrate"])
