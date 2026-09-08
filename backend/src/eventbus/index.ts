import { EventEmitter } from "node:events";
import { redis } from "../cache/redis.js";

/**
 * Cross-module event bus. Modules publish domain events here instead of
 * calling each other directly, so e.g. "economy.transaction" can be
 * observed by audit logging, admin notifications, etc. without those
 * modules being coupled to economy internals.
 *
 * MOCK/DEMO NOTE: this is in-process only (EventEmitter). It does NOT
 * fan out across multiple backend instances. `publishCrossProcess` below
 * is a real Redis pub/sub implementation but nothing subscribes to it
 * yet — wire it up before running more than one backend process.
 */
class EventBus extends EventEmitter {}

export const bus = new EventBus();
bus.setMaxListeners(50);

export type DomainEvent =
  | { type: "economy.transaction"; characterId: number; amountCents: number; reason: string }
  | { type: "character.whitelisted"; characterId: number; by: number }
  | { type: "admin.action"; actorUserId: number | null; action: string };

export function publish(event: DomainEvent) {
  bus.emit(event.type, event);
  bus.emit("*", event);
}

const CROSS_PROCESS_CHANNEL = "bedrock-rp:events";

/** Real Redis publish. No subscriber wired up yet — see class note above. */
export async function publishCrossProcess(event: DomainEvent) {
  await redis.publish(CROSS_PROCESS_CHANNEL, JSON.stringify(event));
}
