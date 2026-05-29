import {
  addProviderAccountsSchema,
  createBankConnectionSchema,
  deleteBankConnectionSchema,
  getBankConnectionsSchema,
  reconnectBankConnectionSchema,
} from "@api/schemas/bank-connections";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";

import {
  addProviderAccounts,
  createBankConnection,
  deleteBankConnection,
  getBankConnections,
  reconnectBankConnection,
} from "@midday/db/queries";
import type { DeleteConnectionPayload } from "@midday/jobs/schema";
import { triggerJob } from "@midday/job-client";
import { createLoggerWithContext } from "@midday/logger";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";

const logger = createLoggerWithContext("trpc:bank-connections");

export const bankConnectionsRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getBankConnectionsSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getBankConnections(db, {
        teamId: teamId!,
        enabled: input?.enabled,
      });
    }),

  create: protectedProcedure
    .input(createBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const data = await createBankConnection(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      });

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Bank connection not found",
        });
      }

      // Run the initial sync on the BullMQ worker. Returns a composite job id
      // ("transactions:<id>") the client polls via jobs.getStatus.
      const event = await triggerJob(
        "initial-bank-setup",
        {
          connectionId: data.id,
          teamId: teamId!,
        },
        "transactions",
      );

      return event;
    }),

  delete: protectedProcedure
    .input(deleteBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const data = await deleteBankConnection(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!data) {
        throw new Error("Bank connection not found");
      }

      // Provider-side cleanup still runs on Trigger.dev. Best-effort: the DB
      // rows are already deleted above, so a missing Trigger.dev config (common
      // on self-hosted deploys) must not fail the user-facing delete.
      // TODO: port delete-connection to a BullMQ processor.
      try {
        await tasks.trigger("delete-connection", {
          referenceId: data.referenceId,
          provider: data.provider!,
          accessToken: data.accessToken,
        } satisfies DeleteConnectionPayload);
      } catch (error) {
        logger.error("Failed to trigger provider connection cleanup", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return data;
    }),

  addAccounts: protectedProcedure
    .input(addProviderAccountsSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const result = await addProviderAccounts(db, {
        connectionId: input.connectionId,
        teamId: teamId!,
        userId: session.user.id,
        accounts: input.accounts,
      });

      return result;
    }),

  reconnect: protectedProcedure
    .input(reconnectBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const result = await reconnectBankConnection(db, {
        referenceId: input.referenceId,
        newReferenceId: input.newReferenceId,
        expiresAt: input.expiresAt,
        teamId: teamId!,
      });

      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bank connection not found",
        });
      }

      return result;
    }),
});
