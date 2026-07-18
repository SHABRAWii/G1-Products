import { NextResponse } from "next/server";
import { databaseConfigured, prisma } from "@/lib/db";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_: Request, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { jobId } = await params;
  const data = await prisma.jobEvent.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ data, meta: { total: data.length } });
}
