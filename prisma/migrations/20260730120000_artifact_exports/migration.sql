-- CreateEnum
CREATE TYPE "ArtifactExportKind" AS ENUM ('DIGITAL_TWIN_MP4');

-- CreateEnum
CREATE TYPE "ArtifactExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ArtifactExport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobStageId" TEXT NOT NULL,
    "kind" "ArtifactExportKind" NOT NULL,
    "status" "ArtifactExportStatus" NOT NULL DEFAULT 'QUEUED',
    "sourceSceneAssetVersionId" TEXT NOT NULL,
    "outputAssetVersionId" TEXT,
    "progressCurrent" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactExport_jobStageId_kind_key" ON "ArtifactExport"("jobStageId", "kind");
CREATE INDEX "ArtifactExport_status_createdAt_idx" ON "ArtifactExport"("status", "createdAt");
CREATE INDEX "ArtifactExport_workspaceId_status_createdAt_idx" ON "ArtifactExport"("workspaceId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ArtifactExport" ADD CONSTRAINT "ArtifactExport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactExport" ADD CONSTRAINT "ArtifactExport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactExport" ADD CONSTRAINT "ArtifactExport_jobStageId_fkey" FOREIGN KEY ("jobStageId") REFERENCES "JobStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactExport" ADD CONSTRAINT "ArtifactExport_sourceSceneAssetVersionId_fkey" FOREIGN KEY ("sourceSceneAssetVersionId") REFERENCES "AssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArtifactExport" ADD CONSTRAINT "ArtifactExport_outputAssetVersionId_fkey" FOREIGN KEY ("outputAssetVersionId") REFERENCES "AssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
