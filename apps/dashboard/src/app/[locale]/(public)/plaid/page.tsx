"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useTRPC } from "@/trpc/client";

/**
 * Plaid OAuth redirect return page.
 *
 * OAuth banks (e.g. Truist) full-page redirect to the bank for authentication
 * and back to this route (registered as the Plaid redirect URI). We re-create
 * Plaid Link with the original link_token + `receivedRedirectUri` so Link
 * resumes and completes, then hand off to the normal account-select step.
 */
export default function PlaidOAuthReturnPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | undefined>();

  useEffect(() => {
    setToken(localStorage.getItem("plaid_link_token"));
    setRedirectUri(window.location.href);
  }, []);

  const exchangeToken = useMutation(
    trpc.banking.plaidExchange.mutationOptions(),
  );

  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri: redirectUri,
    onSuccess: async (publicToken, metadata) => {
      try {
        const result = await exchangeToken.mutateAsync({ token: publicToken });

        const params = new URLSearchParams({
          step: "account",
          provider: "plaid",
          token: result.data.access_token,
          ref: result.data.item_id,
        });

        if (metadata.institution?.institution_id) {
          params.set("institution_id", metadata.institution.institution_id);
        }

        localStorage.removeItem("plaid_link_token");
        router.replace(`/settings/accounts?${params.toString()}`);
      } catch {
        localStorage.removeItem("plaid_link_token");
        router.replace("/settings/accounts?step=connect&error=plaid_exchange");
      }
    },
    onExit: () => {
      localStorage.removeItem("plaid_link_token");
      router.replace("/settings/accounts?step=connect");
    },
  });

  useEffect(() => {
    if (ready && token && redirectUri) {
      open();
    }
  }, [ready, token, redirectUri, open]);

  useEffect(() => {
    if (token === null && redirectUri) {
      // No pending link token — nothing to resume.
      router.replace("/settings/accounts?step=connect");
    }
  }, [token, redirectUri, router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="text-sm text-[#878787]">Completing bank connection…</p>
    </div>
  );
}
