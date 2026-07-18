# Direct model installation

Run the local secret setup first. It prompts silently, creates restricted files under the Git-ignored `.robomotion/secrets/` directory, and never puts credentials into the repository or shell command history.

```bash
bash deploy/configure-model-secrets.sh
```

Then run the single installer from the Dashboard root. It installs only PromptHMR and GMR directly from their upstream repositories; no wrapper repository is downloaded or used.

```bash
source .robomotion/secrets/install.env
bash deploy/install-direct-models.sh
```

The script requires Conda, Git, FFmpeg, `ffprobe`, an NVIDIA-compatible PyTorch environment, and registered SMPL/SMPL-X model accounts. It writes source and model-cache files under `.robomotion/` by default, which is ignored by Git, and produces `.robomotion/worker-models.env` for the worker process.
