import type { Job } from "bullmq";
import { BaseProcessor } from "../base";
import { syncConnection } from "./bank-sync";

export type SyncConnectionPayload = {
  teamId: string;
  connectionId: string;
  manualSync?: boolean;
};

// Syncs a single connection's accounts + transactions. Used for the delayed
// follow-up sync after setup, provider webhooks, and the daily scheduler.
export class SyncConnectionProcessor extends BaseProcessor<SyncConnectionPayload> {
  async process(job: Job<SyncConnectionPayload>): Promise<{
    connectionId: string;
    syncedAccounts: number;
  }> {
    const { connectionId, manualSync } = job.data;

    this.logger.info("Starting connection sync", {
      jobId: job.id,
      connectionId,
      manualSync: Boolean(manualSync),
    });

    const { syncedAccounts } = await syncConnection({
      connectionId,
      manualSync: Boolean(manualSync),
    });

    return { connectionId, syncedAccounts };
  }
}
