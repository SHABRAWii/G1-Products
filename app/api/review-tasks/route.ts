import { ReviewStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const status = request.nextUrl.searchParams.get("status");
  const reviewStatus = status && Object.values(ReviewStatus).includes(status as ReviewStatus) ? status as ReviewStatus : ReviewStatus.PENDING;
  const data = await prisma.reviewTask.findMany({
    where: { status: reviewStatus },
    include: { job: { select: { id: true, name: true, robotModel: true, status: true } }, jobStage: { select: { id: true, position: true, stage: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ data, meta: { status: reviewStatus, total: data.length } });
}
