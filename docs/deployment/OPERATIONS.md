# VPS + RunPod operations

For initial installation, use the
[production deployment guide](../system-structure-and-deployment.md).

## Status

Run on Server 1:

```bash
cd /opt/robomotion
bash control-plane/deploy/status.sh
curl http://127.0.0.1:3000/api/health
```

Controller logs:

```bash
docker compose --env-file control-plane/.env \
  -f control-plane/docker-compose.yml \
  --profile runpod logs -f runpod-controller
```

MP4 exporter logs:

```bash
docker compose --env-file control-plane/.env \
  -f control-plane/docker-compose.yml \
  logs -f artifact-export-worker
```

GPU/model/worker logs are shown in the RunPod Pod log view.

## Restart Server 1 without deleting data

```bash
cd /opt/robomotion
bash control-plane/deploy/up.sh
```

To stop Server 1:

```bash
docker compose --env-file control-plane/.env \
  -f control-plane/docker-compose.yml \
  --profile runpod down
```

Never add `--volumes`.

## Stop Server 2

Stop the Pod from RunPod or let the controller stop it after the idle timeout.
Do not terminate the Pod and do not delete `/workspace` during routine use.

## Update Server 1

```bash
cd /opt/robomotion
git pull --ff-only
bash control-plane/deploy/up.sh
curl http://127.0.0.1:3000/api/health
```

## Update Server 2

1. Build and push a new immutable GPU image.
2. Put its digest in VPS `control-plane/.env` as `RUNPOD_GPU_IMAGE`.
3. Run `bash control-plane/deploy/up.sh` on Server 1.
4. Keep the Pod stopped until the next job.

The controller applies the image while the Pod is stopped. Do not clone or
`git pull` inside RunPod.

## PostgreSQL backup

Run on Server 1:

```bash
cd /opt/robomotion
mkdir -p backups
docker compose --env-file control-plane/.env \
  -f control-plane/docker-compose.yml \
  exec -T postgres pg_dump -U robomotion -d robomotion -Fc \
  > "backups/robomotion-$(date +%Y%m%d-%H%M%S).dump"
```

## Artifact backup

Mirror the `robomotion` bucket to another S3-compatible store with an S3-aware
tool such as MinIO Client. Do not treat a raw live filesystem copy as a
consistent object-store backup.

Database rows and MinIO object keys are one recovery unit. Back them up on the
same schedule.

Also keep encrypted copies of:

```text
control-plane/.env
RunPod secret definitions
the tunnel private key
the GitHub deploy key
```

## Capacity

```bash
df -h
free -h
docker system df
docker volume ls
```

Do not run:

```bash
docker compose down --volumes
docker system prune --volumes
```

## Recovery order

1. Install Server 1 from the production guide.
2. Restore `control-plane/.env` securely.
3. Restore PostgreSQL.
4. Restore the MinIO bucket with object keys unchanged.
5. Start Server 1 and apply migrations through `control-plane/deploy/up.sh`.
6. Recreate the RunPod Pod from the pinned image/template/secrets if needed.
7. Verify an old artifact and run one short new pipeline job.

The RunPod model and Conda caches are rebuildable. PostgreSQL and MinIO data
are not.
