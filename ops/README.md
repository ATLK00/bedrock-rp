# Deploy & backup runbook (backend)

Targets the backend + its data stores only. BDS (the Minecraft server) runs
separately and talks to this backend over HTTP (see `behavior_pack/`).

## Prerequisites

- Linux host with Docker Engine 24+ / Compose v2 (or Windows with Docker Desktop).
- The repo checked out (this runbook assumes you run commands from `ops/`).
- `.env` created from the template — **never commit it**:

```bash
cd ops
cp .env.prod.example .env
# edit .env: POSTGRES_PASSWORD, BDS_BRIDGE_SECRET, DISCORD_*, JWT_SECRET, CORS_ORIGINS...
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # -> JWT_SECRET
```

## First deploy

```bash
cd ops
docker compose -f docker-compose.prod.yml build         # compile TS -> image (no tsx at runtime)
docker compose -f docker-compose.prod.yml run --rm backend node dist/db/migrate.js
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps           # all 3 healthy?
curl http://127.0.0.1:8080/health/ready                # {"checks":{"db":"ok","redis":"ok"}}
```

> Migrations are run explicitly, not at container boot. Run the `run --rm
> backend node dist/db/migrate.js` step on every upgrade that ships a new
> migration (files in `backend/migrations/`).

## Point BDS at it

In your BDS `worlds/<world>/variables.json` (and keep `development_behavior_packs/`
in sync with `behavior_pack/`), set:

```json
{ "bedrock-rp:backendUrl": "http://<host-ip>:8080",
  "bedrock-rp:bridgeSecret": "<same as .env BDS_BRIDGE_SECRET>" }
```

Then reload/restart the world. The pack talks to `backendUrl`; make sure that
address is reachable from wherever BDS runs (same host: `http://127.0.0.1:8080`).
If your Minecraft client-created world has the Beta-APIs experiment flag, run
`tools/leveldat_patch.py` on its `level.dat` first (see README) so joins aren't
blocked by Xbox Live/NetherNet signaling.

## Reverse proxy (optional)

If you put a reverse proxy/load balancer in front of the backend:

- Set `TRUST_PROXY` in `.env` to the number of proxy hops (or a CIDR list) or
  per-IP rate limiting collapses onto the proxy's IP.
- The published `8080:8080` on the backend maps to host `127.0.0.1:8080`, so the
  proxy can be on the same host without exposing the backend publicly.
- Set `DISCORD_REDIRECT_URI` and `CORS_ORIGINS` to the public URLs.

## Backups

```bash
cd ops
./backup.sh                        # -> ops/backups/ (timestamped pg dump + redis rdb), prunes >7d
BACKUP_DIR=/srv/backups RETENTION_DAYS=30 ./backup.sh
```

Cron (every 3h):

```
0 */3 * * * /path/to/repo/ops/backup.sh >> /var/log/bedrock-rp-backup.log 2>&1
```

### Restore

```bash
# postgres (replace the live DB — stop the backend first; dumps are
# pg_dump --format=custom, restore with pg_restore):
cd ops
docker compose -f docker-compose.prod.yml stop backend
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore \
  --clean --if-exists --dbname=postgres://bedrock_rp:"$POSTGRES_PASSWORD"@127.0.0.1:5432/bedrock_rp \
  < ops/backups/postgres_<ts>.dump
docker compose -f docker-compose.prod.yml start backend

# redis (copy an .rdb back in):
docker compose -f docker-compose.prod.yml exec -T redis sh -c 'cat > /data/dump.rdb'
docker compose -f docker-compose.prod.yml restart redis
```

## Day-2 operations

```bash
# logs / reset a stuck container
cd ops && docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml restart backend

# upgrade: rebuild image, migrate, restart
cd ops
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm backend node dist/db/migrate.js
docker compose -f docker-compose.prod.yml up -d
```

The data stores (`pg_data`, `redis_data`) are named volumes; nothing survives in
the container layer, so `build` + `up` never loses state.