import { InitialBankSetupProcessor } from "./initial-bank-setup";
import { SyncConnectionProcessor } from "./sync-connection";

export { InitialBankSetupProcessor } from "./initial-bank-setup";
export { SyncConnectionProcessor } from "./sync-connection";

/**
 * Bank processor registry
 * Maps job names to processor instances
 */
export const bankProcessors = {
  "initial-bank-setup": new InitialBankSetupProcessor(),
  "sync-connection": new SyncConnectionProcessor(),
};
