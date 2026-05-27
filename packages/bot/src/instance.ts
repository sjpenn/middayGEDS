import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { resolveRedisUrl } from "@midday/cache/shared-redis";
import { Chat } from "chat";
import { createSendblueAdapter } from "chat-adapter-sendblue";

// Self-host fix: each chat adapter throws at construction time when its
// credentials env vars are missing (e.g. WHATSAPP_ACCESS_TOKEN). Wrap each
// factory in try/catch so an unconfigured adapter is logged + skipped instead
// of crashing the entire bot boot. Adapters that succeed remain wired in.
function safeAdapter(name, factory) {
  try {
    return factory();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[bot] adapter "${name}" not configured, skipping: ${msg}`);
    return null;
  }
}

export function createMiddayBot() {
  const candidates = [
    ["whatsapp", () => createWhatsAppAdapter()],
    ["telegram", () => createTelegramAdapter()],
    ["slack",    () => createSlackAdapter()],
    ["sendblue", () => createSendblueAdapter()],
  ];
  const adapters = Object.fromEntries(
    candidates
      .map(([name, factory]) => [name, safeAdapter(name, factory)])
      .filter(([, adapter]) => adapter !== null)
  );
  return new Chat({
    userName: "midday",
    adapters,
    state: createRedisState({ url: resolveRedisUrl() }),
    concurrency: {
      strategy: "debounce",
      debounceMs: 1500,
    },
  });
}

export const bot = createMiddayBot();
