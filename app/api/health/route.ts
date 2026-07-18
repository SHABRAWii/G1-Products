import { NextResponse } from "next/server";
import { databaseConfigured, prisma } from "@/lib/db";

export async function GET() {
  const database = { configured: databaseConfigured(), reachable: false };
  if (database.configured) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      database.reachable = true;
    } catch {
      return NextResponse.json({ status: "degraded", service: "robomotion-dashboard", database, timestamp: new Date().toISOString() }, { status: 503 });
    }
  }
  return NextResponse.json({ status: "ok", service: "robomotion-dashboard", database, timestamp: new Date().toISOString() });
}
