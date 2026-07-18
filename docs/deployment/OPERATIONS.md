# Deployment operations

## Service status and logs

```bash
bash deploy/server-status.sh
bash deploy/server-status.sh --follow
```

For a single service:

```bash
docker compose --env-file .env.server -f docker-compose.server.yml --profile gpu logs -f app
docker compose --env-file .env.server -f docker-compose.server.yml --profile gpu logs -f gpu-worker
```

## Restart without deleting data

```bash
docker compose --env-file .env.server -f docker-compose.server.yml --profile gpu restart app gpu-worker
```

## Stop and start

```bash
docker compose --env-file .env.server -f docker-compose.server.yml --profile gpu down
bash deploy/deploy-server.sh
```

`down` without `--volumes` preserves all named volumes. Never add `--volumes` unless permanent data deletion is explicitly intended and verified backups exist.

## Backups

Source code and model installers are reproducible, but jobs and artifacts are not. Back up both PostgreSQL and MinIO.

Create a PostgreSQL dump:

```bash
mkdir -p backups
docker compose --env-file .env.server -f docker-compose.server.yml exec -T postgres \
  pg_dump -U robomotion -d robomotion -Fc > "backups/robomotion-$(date +%Y%m%d-%H%M%S).dump"
```

For MinIO, use an S3-aware backup tool such as `mc mirror` against the internal bucket or snapshot the `minio-data` volume while MinIO is stopped. A raw live copy of MinIO's data directory is not a substitute for a consistent S3 backup.

Keep `.env.server` and `.robomotion/server-secrets/` in a separate encrypted secret backup. Do not place them beside unencrypted database or artifact backups.

## Restoring to another machine

1. Deploy the same or newer RoboMotion commit and stop `app` and `gpu-worker`.
2. Restore the PostgreSQL dump into the `postgres` service.
3. Restore the MinIO bucket with its object keys unchanged.
4. Run `bash deploy/deploy-server.sh` to apply newer migrations and verify models.
5. Confirm `/api/health`, worker readiness, an old artifact download, and a new short pipeline job.

Database rows without their matching MinIO object keys produce broken artifacts. MinIO objects without database lineage remain unreachable from the dashboard. Treat them as one recovery unit.

## Model cache behavior

The installer verifies expected PromptHMR files with a local SHA-256 manifest. Valid assets and Python environments are reused. Missing or invalid components are reinstalled individually.

To inspect bootstrap errors:

```bash
docker compose --env-file .env.server -f docker-compose.server.yml --profile gpu logs model-bootstrap
```

Do not manually edit files inside `model-cache` or `conda-envs`. If a cache is intentionally rebuilt, preserve PostgreSQL and MinIO and remove only the specific model volumes after documenting the action.

## Security boundary

- The MVP currently has no authentication or authorization.
- The dashboard binds to loopback by default.
- MinIO and PostgreSQL are not published as host ports in the server Compose file.
- SMPL/SMPL-X credentials are mounted only into `model-bootstrap` as Docker secrets.
- The application images do not contain `.env.server`, `.robomotion`, or secret files.
- Add authenticated HTTPS ingress before multi-user or internet access.
