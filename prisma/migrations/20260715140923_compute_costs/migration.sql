-- CreateTable
CREATE TABLE "RateCard" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateCardItem" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputeResource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "gpuSku" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "gpuCount" INTEGER NOT NULL DEFAULT 0,
    "vramGb" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComputeResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputeLease" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stageAttemptId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "runtimeSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComputeLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateCard_workspaceId_active_effectiveAt_idx" ON "RateCard"("workspaceId", "active", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateCard_workspaceId_name_key" ON "RateCard"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RateCardItem_rateCardId_sku_key" ON "RateCardItem"("rateCardId", "sku");

-- CreateIndex
CREATE INDEX "ComputeResource_workspaceId_provider_state_idx" ON "ComputeResource"("workspaceId", "provider", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ComputeResource_workspaceId_provider_externalId_key" ON "ComputeResource"("workspaceId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ComputeLease_stageAttemptId_key" ON "ComputeLease"("stageAttemptId");

-- CreateIndex
CREATE INDEX "ComputeLease_workspaceId_state_startedAt_idx" ON "ComputeLease"("workspaceId", "state", "startedAt");

-- CreateIndex
CREATE INDEX "ComputeLease_jobId_startedAt_idx" ON "ComputeLease"("jobId", "startedAt");

-- AddForeignKey
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateCardItem" ADD CONSTRAINT "RateCardItem_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeResource" ADD CONSTRAINT "ComputeResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeLease" ADD CONSTRAINT "ComputeLease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeLease" ADD CONSTRAINT "ComputeLease_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeLease" ADD CONSTRAINT "ComputeLease_stageAttemptId_fkey" FOREIGN KEY ("stageAttemptId") REFERENCES "StageAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeLease" ADD CONSTRAINT "ComputeLease_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "ComputeResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
