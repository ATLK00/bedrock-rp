import { createClient } from "redis";
import { config } from "../config/index.js";

export const redis = createClient({ url: config.REDIS_URL });

redis.on("error", (err) => console.error("[redis] client error", err));

let connected = false;
export async function connectRedis() {
  if (connected) return;
  await redis.connect();
  connected = true;
}
