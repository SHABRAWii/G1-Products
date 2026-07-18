-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PREFLIGHTED', 'QUEUED', 'DISPATCHING', 'RUNNING', 'WAITING_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('PENDING', 'READY', 'LEASED', 'RUNNING', 'AWAITING_REVIEW', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('VIDEO_GENERATION', 'POSE_EXTRACTION', 'POSE_REVIEW', 'ROBOT_RETARGETING', 'VISUALIZATION', 'TRAINING', 'POLICY_EVALUATION', 'SIMULATION_VERIFICATION');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('VIDEO_SOURCE', 'VIDEO_GENERATED', 'POSE_SMPLX', 'POSE_REVIEWED', 'MOTION_ROBOT', 'VISUALIZATION', 'TRAINING_DATASET', 'POLICY_CHECKPOINT', 'EVALUATION_REPORT', 'SIMULATION_EVIDENCE');

-- CreateEnum
CREATE TYPE "AssetApprovalStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CostKind" AS ENUM ('ESTIMATED', 'OBSERVED', 'RECONCILED');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "approvalStatus" "AssetApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "inputAssetVersionId" TEXT,
    "name" TEXT NOT NULL,
    "robotModel" TEXT NOT NULL,
    "startStage" "PipelineStage" NOT NULL,
    "endStage" "PipelineStage" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "plan" JSONB NOT NULL,
    "estimateMinor" INTEGER NOT NULL DEFAULT 0,
    "estimateCurrency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStage" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stage" "PipelineStage" NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'PENDING',
    "adapter" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageAttempt" (
    "id" TEXT NOT NULL,
    "jobStageId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "workerId" TEXT,
    "containerRef" TEXT,
    "status" "StageStatus" NOT NULL DEFAULT 'LEASED',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "result" JSONB NOT NULL DEFAULT '{}',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostLedgerEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" "CostKind" NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rateCard" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_name_key" ON "Project"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Asset_workspaceId_type_idx" ON "Asset"("workspaceId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_assetId_version_key" ON "AssetVersion"("assetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_storageKey_key" ON "AssetVersion"("storageKey");

-- CreateIndex
CREATE INDEX "Job_workspaceId_status_createdAt_idx" ON "Job"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_projectId_createdAt_idx" ON "Job"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "JobStage_status_createdAt_idx" ON "JobStage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobStage_jobId_position_key" ON "JobStage"("jobId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "StageAttempt_jobStageId_attempt_key" ON "StageAttempt"("jobStageId", "attempt");

-- CreateIndex
CREATE INDEX "CostLedgerEntry_workspaceId_createdAt_idx" ON "CostLedgerEntry"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CostLedgerEntry_jobId_createdAt_idx" ON "CostLedgerEntry"("jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_inputAssetVersionId_fkey" FOREIGN KEY ("inputAssetVersionId") REFERENCES "AssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStage" ADD CONSTRAINT "JobStage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageAttempt" ADD CONSTRAINT "StageAttempt_jobStageId_fkey" FOREIGN KEY ("jobStageId") REFERENCES "JobStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostLedgerEntry" ADD CONSTRAINT "CostLedgerEntry_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
