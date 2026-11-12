# agrobayer-local

Levanta en tu máquina cualquier combinación de módulos del portal AgroBayer, como corren en
GCP: un solo origen (`http://localhost:8080`), una sola sesión y la base de cada módulo.

> Prueba de concepto. Las declaraciones de los módulos viven por ahora en `overlays/`; su
> lugar final es la raíz de cada repo (`agb-local.star`).

## Uso

```bash
node agb.mjs                 # lista los módulos y te deja elegir
node agb.mjs wms gestion     # directo
node agb.mjs wms --yes       # sin preguntas
```

- Portal: `http://localhost:8080` → elegís un usuario y entrás.
- Tilt: `http://localhost:10350` → logs, estado y botones (seeds, chequeos).
- **Ctrl+C** apaga todo, contenedores incluidos. Los datos quedan en volúmenes de Docker.

## Requisitos

| Herramienta | Para qué |
|---|---|
| Node 20+ | El runner, el portal y los módulos |
| [Tilt](https://docs.tilt.dev/install) | Orquesta los procesos |
| Docker | Solo si elegís un módulo con Postgres |
| Dependencias de cada repo instaladas | `agb.mjs` avisa qué repo no tiene `node_modules` |

## Cómo funciona

```
agb.mjs ──► descubre ../agrobayer-*/agb-local.star (o overlays/<repo>/agb-local.star)
        ──► agrupa por MODULE, te deja elegir, escribe .agb/selection.json
        ──► tilt up
               ├─ postgres/pg16.yml, pg17.yml   un contenedor por versión, una base por módulo
               ├─ register(agb, ctx) de cada repo  procesos, migraciones, seeds, usuarios
               └─ portal/portal.mjs  :8080      /{módulo}/* + /api/auth/* + /api/shell/nav + JWKS
```

Cada repo declara lo suyo llamando a los helpers del `Tiltfile`:

| Helper | Qué hace |
|---|---|
| `agb.process(module, name, dir, cmd, port, env, deps)` | Un proceso que queda corriendo (dev server, API) |
| `agb.task(module, name, dir, cmd, env, deps, manual)` | Un comando que termina (migraciones; seeds como botón manual) |
| `agb.database(module, postgres)` | Una base en el Postgres 16 o 17 compartido; devuelve `.url` y `.resource` |
| `agb.route(module, label, port)` | Monta el módulo en `/{module}` del portal |
| `agb.users(module, file, check)` | Sus usuarios de prueba; con `check`, el módulo no se monta hasta que pase |

## Usuarios y bloqueo por módulo

Cada módulo declara sus usuarios en un `local-users.json`. El portal los junta por email: el
mismo email en dos módulos es una persona con los dos.

Si un módulo declara un `check`, el portal **no lo monta** (ni su ruta ni sus usuarios) hasta
que su chequeo pase en esta corrida. Los demás módulos siguen funcionando. Para destrabarlo:
corré el seed del módulo en Tilt; el chequeo vuelve a correr solo.

## Módulos declarados en la prueba

| Módulo | Repos | Base | Notas |
|---|---|---|---|
| `wms` | wms-backend, wms-frontend | Postgres 17, schema `wms_app` | Seed manual: `wms-seed` |
| `gestion` | gestion | — (BigQuery) | Necesita `gcloud auth application-default login` para ver datos |
