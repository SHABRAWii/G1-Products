import { PipelineStage, Prisma } from "@prisma/client";

export async function recordJobEvent(tx: Prisma.TransactionClient, input: { jobId: string; type: string; message: string; stage?: PipelineStage; metadata?: Record<string, unknown> }) {
  return tx.jobEvent.create({ data: { jobId: input.jobId, type: input.type, stage: input.stage, message: input.message, metadata: (input.metadata ?? {}) as Prisma.InputJsonValue } });
}
