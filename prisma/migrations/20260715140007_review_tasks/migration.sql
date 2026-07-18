-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReviewTask" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobStageId" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "decisionNote" TEXT,
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTask_jobStageId_key" ON "ReviewTask"("jobStageId");

-- CreateIndex
CREATE INDEX "ReviewTask_status_createdAt_idx" ON "ReviewTask"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewTask_jobId_status_idx" ON "ReviewTask"("jobId", "status");

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_jobStageId_fkey" FOREIGN KEY ("jobStageId") REFERENCES "JobStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
