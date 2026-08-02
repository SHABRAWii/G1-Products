# RoboMotion dashboard plan

This is the implementation plan for a production dashboard that operates the following configurable pipeline:

`prompt / video upload -> video generation -> pose extraction -> pose review -> robot retargeting -> visualization -> training -> policy evaluation -> simulation verification`

Every job declares a **start stage**, an **end stage**, and a source artifact for the start stage. The orchestrator computes only the required, valid stages between them; it does not assume a job begins with a prompt or finishes at simulation.

## Reading order

| Document | Purpose |
| --- | --- |
| [01-product-and-ux.md](01-product-and-ux.md) | Product behavior, navigation, and view-by-view UX requirements. |
| [02-reference-assessment.md](02-reference-assessment.md) | Technical assessment of `AIM-Intelligence/video2robot` and reuse decisions. |
| [03-architecture-and-data.md](03-architecture-and-data.md) | Target architecture, artifact contracts, database schema, storage, and cost model. |
| [04-orchestration-apis.md](04-orchestration-apis.md) | State machine, worker design, validation gates, and API surface. |
| [05-delivery-roadmap-risks.md](05-delivery-roadmap-risks.md) | Deployment, phased delivery plan, acceptance criteria, and risks. |
| [06-training-stage-integration.md](06-training-stage-integration.md) | Status report: wiring `unitree_rl_mjlab` in as the real `TRAINING` stage — what's done, verified, and explicitly deferred. |
| [07-control-and-gpu-plane-split.md](07-control-and-gpu-plane-split.md) | Implemented deployment split, background visualization exports, RunPod wake/update/idle behavior, and security boundary. |

## Locked MVP direction

1. Build and test RoboMotion locally first, then deploy the validated system to the RunPod pod. The deployment includes the dashboard, API/control plane, worker images, storage integration, and GPU execution.
2. Use PromptHMR for pose extraction and GMR for robot retargeting in the MVP. They are isolated behind RoboMotion adapters so they can later be replaced by RoboMotion-owned pose-extraction and retargeting modules without changing the product workflow.
3. Start with Unitree G1 and a tracking-policy integration. Robot, training, and engine adapters remain versioned so the system can grow after the MVP is proven.
4. Track RunPod, storage, and video-generation costs through configurable rate cards. This keeps estimates and actual-cost reporting current when provider prices change; it is not an unresolved infrastructure decision.
5. Require pose review after extraction and before downstream simulation or policy work, with an explicit administrator override for batch or research workflows.
6. Build the dashboard as a polished React application using Next.js and TypeScript, with a shared design system and responsive, accessible interaction quality as MVP requirements.

## Planning scope

RoboMotion is an independently designed, improved implementation. The cloned reference repository was used only to understand the pipeline; it is not bundled, installed, called, or required at runtime. RoboMotion installs PromptHMR and GMR directly from their upstream repositories and owns its frontend, APIs, orchestration, data model, assets, review workflow, training, simulation, cost system, and model adapters.
