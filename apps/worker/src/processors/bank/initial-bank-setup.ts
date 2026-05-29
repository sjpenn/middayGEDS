import { triggerJob } from "@midday/job-client";
import type { Job } from "bullmq";
import { BaseProcessor } from "../base";
import { syncConnection } from "./bank-sync";

export type InitialBankSetupPayload = {
  teamId: string;
  connectionId: string;
};

// Runs once when a bank connection is created. Performs the initial sync
// synchronously (so the connect UI can show completion), then schedules a
// follow-up sync 5 minutes later — providers like Plaid/GoCardLess/Teller can
// take a few minutes to make all transactions available.
export class InitialBankSetupProcessor extends BaseProcessor<InitialBankSetupPayload> {
  async process(job: Job<InitialBankSetupPayload>): Promise<{
    connectionId: string;
    syncedAccounts: number;
  }> {
    const { connectionId, teamId } = job.data;

    this.logger.info("Starting initial bank setup", {
      jobId: job.id,
      connectionId,
      teamId,
    });

    const { syncedAccounts } = await syncConnection({
      connectionId,
      manualSync: true,
    });

    // Follow-up sync to catch transactions the provider fetches slightly later.
    await triggerJob(
      "sync-connection",
      { teamId, connectionId, manualSync: true },
      "transactions",
      { delay: 5 * 60 * 1000 },
    );

    return { connectionId, syncedAccounts };
  }
}
