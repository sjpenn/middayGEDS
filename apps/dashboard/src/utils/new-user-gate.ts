// Self-host: gate disabled. Upstream Midday uses this to block new sign-ups
// on their hosted product after a cutoff date; for a self-hosted install we
// want EVERY login to succeed.
export const NEW_USER_CUTOFF = "2099-01-01T00:00:00.000Z";

export function isBlockedNewUser(_createdAt) {
  return false;
}
