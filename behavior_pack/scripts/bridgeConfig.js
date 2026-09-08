import { variables } from "@minecraft/server-admin";

/**
 * Reads config from the BDS "variables.json" (set via server-admin),
 * NOT hard-coded (MASTER_PROMPT rule 5: no hard-coded secrets/tokens).
 * Server operator must set these in their BDS variables.json before
 * this addon will do anything beyond logging a warning:
 *
 *   { "bedrock-rp:backendUrl": "http://127.0.0.1:8080",
 *     "bedrock-rp:bridgeSecret": "<same value as backend .env BDS_BRIDGE_SECRET>" }
 *
 * Returns null if either variable is missing, so callers can fail loud
 * instead of silently sending requests with an empty secret.
 */
export function getBridgeConfig() {
  const backendUrl = variables.get("bedrock-rp:backendUrl");
  const bridgeSecret = variables.get("bedrock-rp:bridgeSecret");
  if (!backendUrl || !bridgeSecret) return null;
  return { backendUrl, bridgeSecret };
}
