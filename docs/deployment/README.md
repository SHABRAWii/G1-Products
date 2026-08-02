# RoboMotion deployment index

## Production deployment

Use one guide only:

**[Deploy Server 1 (website VPS) and Server 2 (RunPod RTX 4090)](../system-structure-and-deployment.md)**

It contains the complete commands for:

- Ubuntu and Docker installation;
- a read-only GitHub repository deploy key;
- cloning and updating Server 1;
- PostgreSQL, MinIO, dashboard, MP4 exporter, and HTTPS;
- a restricted RunPod-to-VPS SSH tunnel;
- building and publishing the GPU image to GHCR;
- RunPod secrets, template, RTX 4090 Pod, and persistent cache;
- automatic Pod start/stop;
- verification and updates.

Production ownership is fixed:

| Machine | Runs |
|---|---|
| Server 1 · VPS | `control-plane/docker-compose.yml` |
| Server 2 · RunPod | `deploy/Dockerfile.gpu-worker` |

## Do not mix in these legacy paths

These files are retained for local migration/history. They are **not** part of
the VPS + RunPod deployment:

```text
docker-compose.server.yml
.env.server
deploy/prepare-server.sh
deploy/deploy-server.sh
gpu-plane/docker-compose.yml
gpu-plane/.env
gpu-plane/deploy/up.sh
```

Additional reference:

- [file and volume map](FILES.md)
- [operations and recovery](OPERATIONS.md)
