CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);
