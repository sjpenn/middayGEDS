// The new-user gate prevents sign-ups after a cutoff date.
// For self-hosted deployments leave NEW_USER_GATE_ENABLED unset (or "false")
// to disable the gate entirely — every login succeeds.
// On midday.ai production this is enabled with a hardcoded cutoff.

export const NEW_USER_CUTOFF = "2099-01-01T00:00:00.000Z";

export function isBlockedNewUser(createdAt: string | null | undefined) {
  // Gate is disabled unless explicitly enabled via env var.
  // Self-hosted instances leave this unset (default: disabled).
  const gateEnabled =
    process.env.NEW_USER_GATE_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_NEW_USER_GATE_ENABLED === "true";

  if (!gateEnabled) return false;
  if (!createdAt) return false;
  return new Date(createdAt) >= new Date(NEW_USER_CUTOFF);
}
