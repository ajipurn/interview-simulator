import type { Redis } from "ioredis";
import type { EngineState, KvStore } from "./types.js";

/** Rejoin window: a candidate who reconnects within 15 minutes resumes the session. */
export const RESUME_WINDOW_S = 15 * 60;

const key = (interviewId: string) => `engine:${interviewId}`;

export async function saveState(kv: KvStore, state: EngineState): Promise<void> {
  await kv.set(key(state.interviewId), JSON.stringify(state), RESUME_WINDOW_S);
}

export async function loadState(kv: KvStore, interviewId: string): Promise<EngineState | null> {
  const raw = await kv.get(key(interviewId));
  return raw ? (JSON.parse(raw) as EngineState) : null;
}

export async function clearState(kv: KvStore, interviewId: string): Promise<void> {
  await kv.del(key(interviewId));
}

export class RedisKvStore implements KvStore {
  constructor(private redis: Redis) {}
  get(k: string) {
    return this.redis.get(k);
  }
  async set(k: string, v: string, ttlSeconds: number) {
    await this.redis.set(k, v, "EX", ttlSeconds);
  }
  async del(k: string) {
    await this.redis.del(k);
  }
}

/** In-memory KV with real TTL semantics — tests and keyless local runs. */
export class MemoryKvStore implements KvStore {
  private data = new Map<string, { value: string; expiresAt: number }>();
  constructor(private clock: () => number = Date.now) {}

  async get(k: string) {
    const entry = this.data.get(k);
    if (!entry) return null;
    if (this.clock() > entry.expiresAt) {
      this.data.delete(k);
      return null;
    }
    return entry.value;
  }
  async set(k: string, v: string, ttlSeconds: number) {
    this.data.set(k, { value: v, expiresAt: this.clock() + ttlSeconds * 1000 });
  }
  async del(k: string) {
    this.data.delete(k);
  }
}
