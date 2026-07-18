import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const data = await prisma.trainingRun.findMany({ where: { workspaceId: workspace.id }, include: { recipe: true, policy: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body.name !== "string" || typeof body.recipeId !== "string") throw new Error("name and recipeId are required.");
    const { workspace } = await ensureMvpWorkspace();
    const recipe = await prisma.trainingRecipe.findFirst({ where: { id: body.recipeId, workspaceId: workspace.id, active: true } });
    if (!recipe) return NextResponse.json({ error: "An active training recipe is required." }, { status: 400 });
    const policy = typeof body.policyId === "string" ? await prisma.policy.findFirst({ where: { id: body.policyId, workspaceId: workspace.id } }) : null;
    if (body.policyId && !policy) return NextResponse.json({ error: "policyId was not found." }, { status: 400 });
    const data = await prisma.trainingRun.create({ data: { workspaceId: workspace.id, recipeId: recipe.id, policyId: policy?.id, name: body.name.trim(), status: "QUEUED", metrics: {} }, include: { recipe: true, policy: true } });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create training run." }, { status: 400 });
  }
}
