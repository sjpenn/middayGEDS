// The new-user gate prevents sign-ups after a cutoff date.
// For self-hosted deployments set NEW_USER_GATE_ENABLED=false (or leave it
// unset) in your environment to disable the gate entirely.
// On midday.ai production this is enabled by default with a hardcoded cutoff.

export const NEW_USER_CUTOFF = "2026-04-20T00:00:00.000Z";

export function isBlockedNewUser(createdAt: string | null | undefined) {
  // Gate is disabled unless explicitly enabled via env var.
  // Self-hosted instances should leave this unset (default: disabled).
  const gateEnabled =
    process.env.NEW_USER_GATE_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_NEW_USER_GATE_ENABLED === "true";

  if (!gateEnabled) return false;
  if (!createdAt) return false;
  return new Date(createdAt) >= new Date(NEW_USER_CUTOFF);
}
