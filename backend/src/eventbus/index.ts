import { EventEmitter } from "node:events";
import { redis } from "../cache/redis.js";

/**
 * Cross-module event bus. Modules publish domain events here instead of
 * calling each other directly, so e.g. economy changes can be observed by
 * audit logging, admin notifications, etc. without coupling modules.
 *
 * The full event vocabulary of the backend foundation (see
 * AI_HANDOFF.md "Event Bus"): player lifecycle, character lifecycle,
 * money changes, item transfers, admin actions, security alerts and case
 * updates are all published as structured events so future
 * subscribers (notifications, analytics, Discord webhooks) can attach
 * without touching the emitting modules.
 *
 * In-process only (EventEmitter). `publishCrossProcess` is a real Redis
 * pub/sub implementation but nothing subscribes to it yet — wire it up
 * before running more than one backend process.
 */
class EventBus extends EventEmitter {}

export const bus = new EventBus();
bus.setMaxListeners(50);

export type SecuritySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type DomainEvent =
  // economy (legacy name kept — `PLAYER_MONEY_CHANGED` is the canonical one)
  | { type: "economy.transaction"; characterId: number; amountCents: number; reason: string }
  | { type: "PLAYER_MONEY_CHANGED"; characterId: number; amountCents: number; reason: string; currency: string }
  | { type: "character.whitelisted"; characterId: number; by: number }
  | { type: "CHARACTER_CREATED"; characterId: number; by: number }
  | { type: "CHARACTER_CONFIRMED"; characterId: number; by: number }
  | { type: "PLAYER_CONNECTED"; persistentId: string; characterId: number | null }
  | { type: "PLAYER_DISCONNECTED"; persistentId: string }
  | { type: "ITEM_TRANSFERRED"; itemId: string; quantity: number; fromInventoryId: number | null; toInventoryId: number | null; characterId: number | null }
  | { type: "admin.action"; actorUserId: number | null; action: string }
  | { type: "ADMIN_ACTION"; actorUserId: number | null; action: string }
  | { type: "SECURITY_ALERT"; eventType: string; severity: SecuritySeverity }
  | { type: "CASE_CREATED"; caseId: number; by: number }
  | { type: "CASE_UPDATED"; caseId: number; by: number };

export function publish(event: DomainEvent) {
  bus.emit(event.type, event);
  bus.emit("*", event);
}

/** Subscribe to one event type (or "*" for everything). Returns an unsubscribe fn. */
export function subscribe(
  eventType: DomainEvent["type"] | "*",
  handler: (event: DomainEvent) => void
): () => void {
  bus.on(eventType, handler);
  return () => {
    bus.off(eventType, handler);
  };
}

const CROSS_PROCESS_CHANNEL = "bedrock-rp:events";

/** Real Redis publish. No subscriber wired up yet — see class note above. */
export async function publishCrossProcess(event: DomainEvent) {
  await redis.publish(CROSS_PROCESS_CHANNEL, JSON.stringify(event));
}