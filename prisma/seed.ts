import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const workspace = await prisma.workspace.upsert({ where: { slug: "motion-lab" }, update: {}, create: { slug: "motion-lab", name: "Motion Lab" } });
  const project = await prisma.project.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name: "RoboMotion MVP" } }, update: {}, create: { workspaceId: workspace.id, name: "RoboMotion MVP" } });
  const rateCard = await prisma.rateCard.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name: "Local MVP rate card" } }, update: { active: true }, create: { workspaceId: workspace.id, name: "Local MVP rate card", active: true, currency: "USD" } });
  await prisma.budget.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name: "Monthly MVP budget" } }, update: {}, create: { workspaceId: workspace.id, name: "Monthly MVP budget", limitMinor: 30_000, alertPercent: 80, enforcement: "WARN" } });
  for (const item of [
    { sku: "runpod-gpu-minute", category: "runpod_compute", unit: "minute", amountMinor: 2 },
    { sku: "video-generation-minute", category: "video_generation", unit: "minute", amountMinor: 36 },
    { sku: "storage-gib-month", category: "storage", unit: "gib-month", amountMinor: 2 },
  ]) {
    await prisma.rateCardItem.upsert({ where: { rateCardId_sku: { rateCardId: rateCard.id, sku: item.sku } }, update: item, create: { rateCardId: rateCard.id, ...item } });
  }
}

main().finally(() => prisma.$disconnect());
