-- CreateEnum
CREATE TYPE "StageArtifactRole" AS ENUM ('INPUT', 'OUTPUT', 'PREVIEW', 'EVIDENCE');

-- CreateTable
CREATE TABLE "StageArtifact" (
    "id" TEXT NOT NULL,
    "jobStageId" TEXT NOT NULL,
    "assetVersionId" TEXT NOT NULL,
    "role" "StageArtifactRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StageArtifact_assetVersionId_idx" ON "StageArtifact"("assetVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "StageArtifact_jobStageId_assetVersionId_role_key" ON "StageArtifact"("jobStageId", "assetVersionId", "role");

-- AddForeignKey
ALTER TABLE "StageArtifact" ADD CONSTRAINT "StageArtifact_jobStageId_fkey" FOREIGN KEY ("jobStageId") REFERENCES "JobStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageArtifact" ADD CONSTRAINT "StageArtifact_assetVersionId_fkey" FOREIGN KEY ("assetVersionId") REFERENCES "AssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
