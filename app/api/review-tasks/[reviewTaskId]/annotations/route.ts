import { ReviewStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, prisma } from "@/lib/db";

type Context = { params: Promise<{ reviewTaskId: string }> };

export async function GET(_: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { reviewTaskId } = await params;
  const data = await prisma.reviewAnnotation.findMany({ where: { reviewTaskId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ data, meta: { total: data.length } });
}

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { reviewTaskId } = await params;
    const body = await request.json();
    if (typeof body.kind !== "string" || !body.kind.trim()) throw new Error("kind is required.");
    if (typeof body.createdBy !== "string" || !body.createdBy.trim()) throw new Error("createdBy is required.");
    if (body.startMs !== undefined && (!Number.isInteger(body.startMs) || body.startMs < 0)) throw new Error("startMs must be a non-negative integer.");
    if (body.endMs !== undefined && (!Number.isInteger(body.endMs) || body.endMs < 0)) throw new Error("endMs must be a non-negative integer.");
    if (body.startMs !== undefined && body.endMs !== undefined && body.endMs < body.startMs) throw new Error("endMs must be at or after startMs.");
    const task = await prisma.reviewTask.findUnique({ where: { id: reviewTaskId } });
    if (!task) return NextResponse.json({ error: "Review task was not found." }, { status: 404 });
    if (task.status !== ReviewStatus.PENDING) return NextResponse.json({ error: "Annotations can only be added while review is pending." }, { status: 409 });
    const data = await prisma.reviewAnnotation.create({ data: { reviewTaskId, kind: body.kind.trim(), startMs: body.startMs, endMs: body.endMs, payload: typeof body.payload === "object" && body.payload !== null ? body.payload : {}, createdBy: body.createdBy.trim() } });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create annotation." }, { status: 400 });
  }
}
