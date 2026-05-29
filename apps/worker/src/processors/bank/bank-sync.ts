import { Provider, ProviderError } from "@midday/banking";
import {
  type UpsertTransactionData,
  upsertTransactions,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { createLoggerWithContext } from "@midday/logger";
import { createClient } from "@midday/supabase/job";
import { getDb } from "../../utils/db";

const logger = createLoggerWithContext("worker:bank-sync");

const BATCH_SIZE = 500;

type ProviderName = "gocardless" | "plaid" | "teller" | "enablebanking";

type AccountType =
  | "credit"
  | "depository"
  | "other_asset"
  | "other_liability"
  | "loan";

// Plaid/Teller/GoCardless only deliver posted transactions to us today, so the
// classification used for provider calls collapses to credit vs depository.
function getClassification(
  type: AccountType | null | undefined,
): "credit" | "depository" {
  return type === "credit" ? "credit" : "depository";
}

// A normalized provider transaction (the shape returned by Provider.getTransactions).
type ProviderTransaction = {
  id: string;
  name: string;
  description: string | null;
  date: string;
  amount: number;
  currency: string;
  method: string | null;
  category: string | null;
  balance: number | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  status: "pending" | "posted";
};

function toUpsertTransaction(
  tx: ProviderTransaction,
  teamId: string,
  bankAccountId: string,
  manualSync: boolean,
): UpsertTransactionData {
  return {
    name: tx.name,
    date: tx.date,
    // The DB transaction_methods enum is broader than this TS union; the cast
    // keeps types happy while the provider value (e.g. "card_atm") passes through.
    method: (tx.method ?? "other") as UpsertTransactionData["method"],
    amount: tx.amount,
    currency: tx.currency,
    teamId,
    bankAccountId,
    internalId: `${teamId}_${tx.id}`,
    // We only ingest posted transactions today.
    status: "posted",
    manual: false,
    categorySlug: tx.category ?? null,
    description: tx.description ?? null,
    balance: tx.balance ?? null,
    counterpartyName: tx.counterparty_name ?? null,
    merchantName: tx.merchant_name ?? null,
    // Manual/initial sync should not fire per-transaction notifications.
    notified: manualSync,
    enrichmentCompleted: false,
  };
}

type SyncAccountInput = {
  id: string;
  teamId: string;
  accountId: string;
  accountType: AccountType;
  accessToken?: string;
  provider: ProviderName;
  manualSync: boolean;
  errorRetries: number;
};

// Sync a single bank account: refresh balance, then fetch + upsert transactions.
// Returns the ids of newly inserted transactions (for enrichment + matching).
async function syncAccount(
  supabase: ReturnType<typeof createClient>,
  account: SyncAccountInput,
): Promise<string[]> {
  const {
    id,
    teamId,
    accountId,
    accountType,
    accessToken,
    provider,
    manualSync,
    errorRetries,
  } = account;

  const api = new Provider({ provider });
  const classification = getClassification(accountType);

  // --- Balance ---
  try {
    const balanceData = await api.getAccountBalance({
      accessToken,
      accountId,
      accountType: classification,
    });

    const balance = balanceData?.amount ?? null;

    if (balance !== null) {
      await supabase
        .from("bank_accounts")
        .update({
          balance,
          available_balance: balanceData?.available_balance ?? null,
          credit_limit: balanceData?.credit_limit ?? null,
          error_details: null,
          error_retries: null,
        })
        .eq("id", id);
    } else {
      await supabase
        .from("bank_accounts")
        .update({ error_details: null, error_retries: null })
        .eq("id", id);
    }
  } catch (error) {
    if (error instanceof ProviderError && error.code === "disconnected") {
      await supabase
        .from("bank_accounts")
        .update({
          error_details: error.message,
          error_retries: errorRetries + 1,
        })
        .eq("id", id);

      throw error;
    }

    logger.error("Failed to sync account balance", {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- Transactions ---
  const transactionsData = (await api.getTransactions({
    accountId,
    accountType: classification,
    accessToken,
    // Manual/initial sync pulls the full history; background sync only the latest.
    latest: !manualSync,
  })) as ProviderTransaction[] | undefined;

  // Reset error state now that the provider responded successfully.
  await supabase
    .from("bank_accounts")
    .update({ error_details: null, error_retries: null })
    .eq("id", id);

  if (!transactionsData || transactionsData.length === 0) {
    logger.info("No transactions to upsert", { accountId });
    return [];
  }

  const db = getDb();
  const insertedIds: string[] = [];

  for (let i = 0; i < transactionsData.length; i += BATCH_SIZE) {
    const batch = transactionsData
      .slice(i, i + BATCH_SIZE)
      .map((tx) => toUpsertTransaction(tx, teamId, id, manualSync));

    const upserted = await upsertTransactions(db, {
      transactions: batch,
      teamId,
    });

    insertedIds.push(...upserted.map((row) => row.id));
  }

  return insertedIds;
}

export type SyncConnectionInput = {
  connectionId: string;
  manualSync: boolean;
};

// Fan-in sync for a whole connection: verify provider status, then sync every
// enabled account and kick off enrichment + inbox matching for new transactions.
export async function syncConnection({
  connectionId,
  manualSync,
}: SyncConnectionInput): Promise<{ syncedAccounts: number }> {
  const supabase = createClient();

  const { data: connection } = await supabase
    .from("bank_connections")
    .select("provider, access_token, reference_id, team_id")
    .eq("id", connectionId)
    .single()
    .throwOnError();

  if (!connection || !connection.team_id || !connection.provider) {
    throw new Error("Connection not found");
  }

  const provider = connection.provider as ProviderName;
  const teamId: string = connection.team_id;
  const accessToken = connection.access_token ?? undefined;

  const api = new Provider({ provider });

  const status = await api.getConnectionStatus({
    id: connection.reference_id ?? undefined,
    accessToken,
  });

  if (status.status === "disconnected") {
    logger.info("Connection disconnected", { connectionId });
    await supabase
      .from("bank_connections")
      .update({ status: "disconnected" })
      .eq("id", connectionId);
    return { syncedAccounts: 0 };
  }

  await supabase
    .from("bank_connections")
    .update({
      status: "connected",
      last_accessed: new Date().toISOString(),
    })
    .eq("id", connectionId);

  let query = supabase
    .from("bank_accounts")
    .select("id, account_id, type, error_retries")
    .eq("bank_connection_id", connectionId)
    .eq("enabled", true)
    .eq("manual", false);

  // Background sync skips accounts that keep erroring; manual sync retries all
  // so reconnecting clears stale errors.
  if (!manualSync) {
    query = query.or("error_retries.lt.4,error_retries.is.null");
  }

  const { data: accounts } = await query.throwOnError();

  if (!accounts || accounts.length === 0) {
    logger.info("No enabled bank accounts to sync", { connectionId });
    return { syncedAccounts: 0 };
  }

  const allTransactionIds: string[] = [];
  let syncedAccounts = 0;

  for (const account of accounts) {
    if (!account.account_id) {
      continue;
    }

    try {
      const ids = await syncAccount(supabase, {
        id: account.id,
        teamId,
        accountId: account.account_id,
        accountType: (account.type ?? "depository") as AccountType,
        accessToken,
        provider,
        manualSync,
        errorRetries: account.error_retries ?? 0,
      });
      allTransactionIds.push(...ids);
      syncedAccounts += 1;
    } catch (error) {
      logger.error("Failed to sync account", {
        accountId: account.account_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (allTransactionIds.length > 0) {
    await triggerJob(
      "enrich-transactions",
      { transactionIds: allTransactionIds, teamId },
      "transactions",
    );

    await triggerJob(
      "match-transactions-bidirectional",
      { teamId, newTransactionIds: allTransactionIds },
      "inbox",
    );
  }

  logger.info("Connection sync completed", {
    connectionId,
    syncedAccounts,
    newTransactions: allTransactionIds.length,
  });

  return { syncedAccounts };
}
