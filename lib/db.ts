import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export async function ensureMvpWorkspace() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: "motion-lab" },
    update: {},
    create: { slug: "motion-lab", name: "Motion Lab" },
  });
  const project = await prisma.project.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "RoboMotion MVP" } },
    update: {},
    create: { workspaceId: workspace.id, name: "RoboMotion MVP" },
  });
  return { workspace, project };
}
