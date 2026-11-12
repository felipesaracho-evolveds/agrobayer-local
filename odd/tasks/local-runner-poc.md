# local-runner-poc

Objective: proof of concept of a module-agnostic local runner (Tilt + unified portal emulator) for AgroBayer modules, validated with WMS and gestion, without touching module repos.
Branch: main (local repo `agrobayer-local`, not pushed) · Delivery: single slice · Runner: manual run (`node agb.mjs`), no test framework.

## Specs

- S1. One command discovers repos in the workspace, lists modules, lets the user pick several, and starts them. User flow (verbatim): "ejecuto el comando -> El script recorre los repos que tengo en el directorio con esa nomenclatura y me muestra un listado -> Selecciono los que quiero levantar -> Me levanta los modulos seleccionados".
- S2. Modules are grouped by module id, not by folder name (naming varies: `-backend/-frontend/-infra`, single repo, `/infra` folder).
- S3. Omitted: infra/terraform repos, platform-*, automated-github-management, sellout-migracion (archived), module-template, shell, auth-host, identity-api, visitas-backend/visitas-infra placeholders. Only repos with a declaration (`agb-local.star`, in the repo or in `overlays/<repo>/` during the PoC) are listed.
- S4. "cuando el usuario selecciona varias darle un aviso que puede consumir mas recursos".
- S5. Apps run native; Postgres runs in Docker, one container per major version (16, 17), one database per module.
- S6. Single origin `localhost:8080`: the portal emulator routes `/{id}/*`, serves `/api/auth/*`, `/api/shell/nav`, JWKS and proxies `/tokens.css`. One session cookie for every module.
- S7. Each module declares its users in `local-users.json`; the portal lists the merged users (by email) of the selected modules.
- S8. Users check: "Bloquear solo el modulo que falla". A module whose users check fails is not mounted (route + users hidden); the rest keeps running.
- S9. Each module owns its declaration (final home: each module repo). During the PoC the declarations live in `overlays/` so module repos stay untouched.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S4, S9 | inline | done | `agb.mjs`: lists gestion + wms (wms grouped from 2 repos), warning + cancel, invalid input, unknown module, Docker preflight |
| T2 | S5 | inline | blocked | compose + ensure-db written; not run: virtualization disabled in BIOS (`VirtualizationFirmwareEnabled=False`, `HCS_E_HYPERV_NOT_INSTALLED`) |
| T3 | S6-S8 | inline | done | gestion through :8080: login 302, whoami 200 / 401 without cookie / 403 for a user without the module; nav filtered; gating simulated on a scratch portal (pending/blocked/stale/ok); run-check pass + fail |
| T4 | S1-S9 | inline | partial | gestion end-to-end OK on Windows with Tilt and no Kubernetes; WMS pending Docker |

## Log

- L1 (2026-11-12, user): "Ok ahora que ya tenemos la idea base (exponer todo en el puerto del backend), siguiendo la arquitectura de self contained systems que siguen todos los modulos, podriamos crear una solucion agnostica? [...] Tendria sentido utilizar docker o seguimos con este enfoque que tenemos aca?"
- L2: decisions: Tilt; manifests per module repo; one Postgres container per major version; users list = `local-users.json` shared by seed and Tiltfile; per-module blocking on users check; Docker Desktop installed in `D:\Docker`.
- L3: PoC built in `agrobayer-local/` with overlays for wms-backend, wms-frontend and gestion.
- L4 (user): "Moveme la instalacion de docker al D: porque se intalo en el C:" → reinstalled to `D:\Docker\Desktop`, data root `D:\Docker\wsl`. "me dice esto wsl --update para que arranque, configuralo para que se guarde en el D: tambien" → WSL updated to 3.0.5; Docker disk at `D:\Docker\wsl\main\ext4.vhdx`.
- L5: gestion needed `GCP_PROJECT_ID` (dev project as default) and a web build before its API (`gestion-web-build` task). Its deps were installed with `npm ci` + gcloud token.
- Next: enable virtualization in BIOS + Virtual Machine Platform, then run `node agb.mjs wms gestion`.
