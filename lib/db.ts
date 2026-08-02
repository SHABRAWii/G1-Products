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
  await prisma.robotModel.upsert({
    where: { workspaceId_slug: { workspaceId: workspace.id, slug: "unitree_g1" } },
    update: { name: "Unitree G1", dof: 29, active: true },
    create: { workspaceId: workspace.id, slug: "unitree_g1", name: "Unitree G1", dof: 29, config: { motionContract: "motion.robot.unitree-g1-29dof-npz/v2" } },
  });
  return { workspace, project };
}
