import { bankingCache, CacheTTL } from "@midday/cache/banking-cache";
import { formatISO, subDays } from "date-fns";
import {
  Configuration,
  type CountryCode,
  type ItemPublicTokenExchangeResponse,
  type LinkTokenCreateResponse,
  PlaidApi as PlaidBaseApi,
  PlaidEnvironments,
  Products,
  type Transaction,
} from "plaid";
import { env } from "../../env";
import type { ConnectionStatus, GetInstitutionsRequest } from "../../types";
import { PLAID_COUNTRIES } from "../../utils/countries";
import { ProviderError } from "../../utils/error";
import { logger } from "../../utils/logger";
import { paginate } from "../../utils/paginate";
import { withRateLimitRetry, withRetry } from "../../utils/retry";
import type {
  DisconnectAccountRequest,
  GetAccountBalanceRequest,
  GetAccountBalanceResponse,
  GetAccountsRequest,
  GetAccountsResponse,
  GetConnectionStatusRequest,
  GetStatusResponse,
  GetTransactionsRequest,
  GetTransactionsResponse,
  ItemPublicTokenExchangeRequest,
  LinkTokenCreateRequest,
} from "./types";
import { isError } from "./utils";

export class PlaidApi {
  #client: PlaidBaseApi;
  #clientId: string;
  #clientSecret: string;

  #countryCodes = PLAID_COUNTRIES as CountryCode[];

  constructor() {
    this.#clientId = env.PLAID_CLIENT_ID;
    this.#clientSecret = env.PLAID_SECRET;

    const configuration = new Configuration({
      basePath: PlaidEnvironments[env.PLAID_ENVIRONMENT],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": this.#clientId,
          "PLAID-SECRET": this.#clientSecret,
        },
      },
    });

    this.#client = new PlaidBaseApi(configuration);
  }

  #generateWebhookUrl(environment: "sandbox" | "production") {
    // Self-hosted instances set MIDDAY_API_URL to their own API origin so Plaid
    // webhooks reach this deployment instead of the upstream midday.ai service.
    const base =
      process.env.MIDDAY_API_URL ||
      (environment === "sandbox"
        ? "https://api-staging.midday.ai"
        : "https://api.midday.ai");

    return `${base.replace(/\/$/, "")}/webhook/plaid`;
  }

  async getHealthCheck() {
    try {
      const response = await fetch(
        "https://status.plaid.com/api/v2/status.json",
      );

      const data = (await response.json()) as GetStatusResponse;

      return (
        data.status.indicator === "none" ||
        data.status.indicator === "maintenance"
      );
    } catch {
      return false;
    }
  }

  async getAccountBalance({
    accessToken,
    accountId,
  }: GetAccountBalanceRequest): Promise<GetAccountBalanceResponse | undefined> {
    try {
      const accounts = await withRateLimitRetry(() =>
        this.#client.accountsGet({
          access_token: accessToken,
          options: {
            account_ids: [accountId],
          },
        }),
      );

      const account = accounts.data.accounts.at(0);
      if (!account) return undefined;

      // Return both balances and type so provider can infer correct balance field
      return {
        balances: account.balances,
        type: account.type,
      };
    } catch (error) {
      const parsedError = isError(error);

      if (parsedError) {
        throw new ProviderError(parsedError);
      }
    }
  }

  async getAccounts({
    accessToken,
    institutionId,
  }: GetAccountsRequest): Promise<GetAccountsResponse | undefined> {
    try {
      const accounts = await withRateLimitRetry(() =>
        this.#client.accountsGet({
          access_token: accessToken,
        }),
      );

      // The access_token already identifies the Item and its institution, so
      // fall back to the Item's institution_id when the caller didn't supply
      // one (e.g. the Hosted Link completion flow, which has no Link metadata).
      const resolvedInstitutionId =
        institutionId ?? accounts.data.item.institution_id ?? undefined;

      if (!resolvedInstitutionId) {
        throw new Error("Unable to resolve institutionId for Plaid accounts");
      }

      const institution = await this.institutionsGetById(resolvedInstitutionId);

      return accounts.data.accounts.map((account) => ({
        ...account,
        institution: {
          id: institution.data.institution.institution_id,
          name: institution.data.institution.name,
        },
      }));
    } catch (error) {
      const parsedError = isError(error);

      if (parsedError) {
        throw new ProviderError(parsedError);
      }
    }
  }

  async getTransactions({
    accessToken,
    accountId,
    latest,
  }: GetTransactionsRequest): Promise<GetTransactionsResponse | undefined> {
    try {
      let transactions: Array<Transaction> = [];

      if (latest) {
        // Get transactions from the last 5 days using /transactions/get
        const { data } = await withRateLimitRetry(() =>
          this.#client.transactionsGet({
            access_token: accessToken,
            start_date: formatISO(subDays(new Date(), 5), {
              representation: "date",
            }),
            end_date: formatISO(new Date(), {
              representation: "date",
            }),
          }),
        );

        transactions = data.transactions;
      } else {
        // Get all transactions using /transactions/sync
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const { data } = await withRateLimitRetry(() =>
            this.#client.transactionsSync({
              access_token: accessToken,
              cursor,
            }),
          );

          transactions = transactions.concat(data.added);
          hasMore = data.has_more;
          cursor = data.next_cursor;
        }
      }

      // NOTE: Plaid transactions for all accounts
      // we need to filter based on the provided accountId and pending status
      return transactions
        .filter((transaction) => transaction.account_id === accountId)
        .filter((transaction) => !transaction.pending);
    } catch (error) {
      const parsedError = isError(error);

      if (parsedError) {
        throw new ProviderError(parsedError);
      }
    }
  }

  async linkTokenCreate({
    userId,
    language = "en",
    accessToken,
    environment = "production",
    redirectUri,
    hostedCompletionUri,
  }: LinkTokenCreateRequest): Promise<
    import("axios").AxiosResponse<LinkTokenCreateResponse>
  > {
    return this.#client.linkTokenCreate({
      client_id: this.#clientId,
      secret: this.#clientSecret,
      client_name: "Midday",
      products: [Products.Transactions],
      language,
      access_token: accessToken,
      country_codes: this.#countryCodes,
      webhook: this.#generateWebhookUrl(environment),
      // Enables the OAuth redirect flow for OAuth banks. Omitted when unset so
      // non-OAuth setups keep the popup flow.
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      // Hosted Link: Plaid hosts the entire Link flow (incl. OAuth) on its own
      // domain and redirects back to completion_redirect_uri. Avoids the
      // embedded-popup OAuth flow that crashes on self-hosted web.
      ...(hostedCompletionUri
        ? {
            hosted_link: {
              completion_redirect_uri: hostedCompletionUri,
            },
          }
        : {}),
      transactions: {
        days_requested: 730,
      },
      user: {
        client_user_id: userId,
      },
      // biome-ignore lint/suspicious/noExplicitAny: hosted_link typing varies by SDK minor version
    } as any);
  }

  // Retrieve a completed Link session (used by Hosted Link, which has no
  // frontend onSuccess). Returns the public_token once the user finishes.
  async linkTokenGet(linkToken: string): Promise<string | null> {
    const { data } = await this.#client.linkTokenGet({ link_token: linkToken });
    const d = data as unknown as {
      link_sessions?: Array<{
        results?: {
          item_add_results?: Array<{ public_token?: string }>;
        };
        on_success?: { public_token?: string };
      }>;
    };

    for (const session of d.link_sessions ?? []) {
      const fromResults = session.results?.item_add_results?.[0]?.public_token;
      if (fromResults) return fromResults;
      if (session.on_success?.public_token) return session.on_success.public_token;
    }

    return null;
  }

  async institutionsGetById(institution_id: string) {
    return bankingCache.getOrSet(
      `plaid_institution_${institution_id}`,
      CacheTTL.TWENTY_FOUR_HOURS,
      () =>
        this.#client.institutionsGetById({
          institution_id,
          country_codes: this.#countryCodes,
          options: {
            include_auth_metadata: true,
          },
        }),
    );
  }

  async itemPublicTokenExchange({
    publicToken,
  }: ItemPublicTokenExchangeRequest): Promise<
    import("axios").AxiosResponse<ItemPublicTokenExchangeResponse>
  > {
    return this.#client.itemPublicTokenExchange({
      public_token: publicToken,
    });
  }

  async deleteAccounts({ accessToken }: DisconnectAccountRequest) {
    await this.#client.itemRemove({
      access_token: accessToken,
    });
  }

  async getInstitutions(params?: GetInstitutionsRequest) {
    const countryCode = params?.countryCode
      ? [params.countryCode as CountryCode]
      : this.#countryCodes;

    return bankingCache.getOrSet(
      `plaid_institutions_${params?.countryCode ?? "all"}`,
      CacheTTL.TWENTY_FOUR_HOURS,
      () =>
        paginate({
          delay: {
            milliseconds: 100,
            onDelay: (message) => logger.info(message),
          },
          pageSize: 500,
          fetchData: (offset, count) =>
            withRetry(() =>
              this.#client
                .institutionsGet({
                  country_codes: countryCode,
                  count,
                  offset,
                  options: {
                    include_optional_metadata: true,
                    products: [Products.Transactions],
                  },
                })
                .then(({ data }) => {
                  return data.institutions;
                }),
            ),
        }),
    );
  }

  async getConnectionStatus({
    accessToken,
  }: GetConnectionStatusRequest): Promise<ConnectionStatus> {
    try {
      await this.#client.accountsGet({
        access_token: accessToken,
      });

      return { status: "connected" };
    } catch (error) {
      const parsedError = isError(error);

      if (parsedError) {
        const providerError = new ProviderError(parsedError);

        if (providerError.code === "disconnected") {
          return { status: "disconnected" };
        }
      }

      logger.error("Plaid connection status check failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      return { status: "connected" };
    }
  }
}
