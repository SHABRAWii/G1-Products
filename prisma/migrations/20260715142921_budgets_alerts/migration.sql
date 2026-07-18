-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "limitMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "alertPercent" INTEGER NOT NULL DEFAULT 80,
    "enforcement" TEXT NOT NULL DEFAULT 'WARN',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetAlert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "jobId" TEXT,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "forecastMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_workspaceId_active_idx" ON "Budget"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_workspaceId_name_key" ON "Budget"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "BudgetAlert_workspaceId_createdAt_idx" ON "BudgetAlert"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "BudgetAlert_budgetId_createdAt_idx" ON "BudgetAlert"("budgetId", "createdAt");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAlert" ADD CONSTRAINT "BudgetAlert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAlert" ADD CONSTRAINT "BudgetAlert_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
