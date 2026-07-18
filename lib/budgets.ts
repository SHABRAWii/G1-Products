import { CostKind, Prisma } from "@prisma/client";
import { recordJobEvent } from "@/lib/events";

export async function enforceDispatchBudget(tx: Prisma.TransactionClient, input: { workspaceId: string; jobId: string; estimateMinor: number }) {
  const budgets = await tx.budget.findMany({ where: { workspaceId: input.workspaceId, active: true } });
  if (!budgets.length) return { blocked: false };
  const observed = await tx.costLedgerEntry.aggregate({ where: { workspaceId: input.workspaceId, kind: { in: [CostKind.OBSERVED, CostKind.RECONCILED] } }, _sum: { amountMinor: true } });
  const baseSpend = observed._sum.amountMinor ?? 0;
  for (const budget of budgets) {
    const forecastMinor = baseSpend + input.estimateMinor;
    const percentage = Math.floor((forecastMinor / budget.limitMinor) * 100);
    if (percentage < budget.alertPercent) continue;
    const level = forecastMinor > budget.limitMinor && budget.enforcement === "BLOCK" ? "BLOCKED" : "WARNING";
    await tx.budgetAlert.create({ data: { workspaceId: input.workspaceId, budgetId: budget.id, jobId: input.jobId, level, forecastMinor, message: `${budget.name} forecast is ${percentage}% of its limit.` } });
    if (level === "BLOCKED") {
      await tx.job.update({ where: { id: input.jobId }, data: { status: "BLOCKED" } });
      await recordJobEvent(tx, { jobId: input.jobId, type: "budget_blocked", message: `${budget.name} blocked dispatch.`, metadata: { budgetId: budget.id, forecastMinor, limitMinor: budget.limitMinor } });
      return { blocked: true, budgetId: budget.id };
    }
  }
  return { blocked: false };
}
