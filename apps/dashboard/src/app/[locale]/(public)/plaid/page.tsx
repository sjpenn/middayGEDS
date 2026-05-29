"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Plaid Hosted Link completion handler.
 *
 * Plaid hosts the entire Link flow (including OAuth) on its own domain and
 * redirects here on completion. Hosted Link has no frontend onSuccess, so we
 * fetch the public_token from the completed session (by the link_token we
 * persisted before redirecting), exchange it, and hand off to account-select.
 */
export default function PlaidHostedCompletePage() {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState(false);
  const ran = useRef(false);

  const hostedComplete = useMutation(
    trpc.banking.plaidHostedComplete.mutationOptions(),
  );
  const exchangeToken = useMutation(
    trpc.banking.plaidExchange.mutationOptions(),
  );

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const linkToken =
      typeof window !== "undefined"
        ? localStorage.getItem("plaid_link_token")
        : null;

    if (!linkToken) {
      router.replace("/settings/accounts?step=connect");
      return;
    }

    (async () => {
      // The session may take a moment to finalize after the redirect.
      let publicToken: string | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const res = await hostedComplete.mutateAsync({ linkToken });
          publicToken = res.data.publicToken;
          if (publicToken) break;
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      if (!publicToken) {
        localStorage.removeItem("plaid_link_token");
        setError(true);
        router.replace("/settings/accounts?step=connect&error=plaid_session");
        return;
      }

      try {
        const result = await exchangeToken.mutateAsync({ token: publicToken });
        localStorage.removeItem("plaid_link_token");

        const params = new URLSearchParams({
          step: "account",
          provider: "plaid",
          token: result.data.access_token,
          ref: result.data.item_id,
        });
        router.replace(`/settings/accounts?${params.toString()}`);
      } catch {
        localStorage.removeItem("plaid_link_token");
        setError(true);
        router.replace("/settings/accounts?step=connect&error=plaid_exchange");
      }
    })();
  }, [hostedComplete, exchangeToken, router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="text-sm text-[#878787]">
        {error ? "Connection failed. Redirecting…" : "Completing bank connection…"}
      </p>
    </div>
  );
}
