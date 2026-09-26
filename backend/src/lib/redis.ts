import { createClient, RedisClientType } from 'redis';

let client: RedisClientType;

export async function connectRedis(): Promise<void> {
  client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;

  client.on('error', (err) => {
    console.error('[redis] Error:', err);
  });

  client.on('connect', () => {
    console.log('[redis] Connected');
  });

  await client.connect();
}

export function getRedis(): RedisClientType {
  if (!client) {
    throw new Error('Redis client not initialized. Call connectRedis() first.');
  }
  return client;
}

// ─── Pub/Sub helper ──────────────────────────────────────────────────────
export async function publish(channel: string, message: object): Promise<void> {
  await getRedis().publish(channel, JSON.stringify(message));
}

// ─── Rate limiter helpers ────────────────────────────────────────────────

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Returns { allowed: boolean, remaining: number, resetAt: Date }
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const resetAt = new Date(now + windowMs);

  const redis = getRedis();
  const fullKey = `rate_limit:${key}`;

  await redis.zRemRangeByScore(fullKey, 0, windowStart);
  const count = await redis.zCard(fullKey);

  if (count >= limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  await redis.zAdd(fullKey, { score: now, value: `${now}-${Math.random()}` });
  await redis.expire(fullKey, Math.ceil(windowMs / 1000));

  return { allowed: true, remaining: limit - count - 1, resetAt };
}

// ─── Presence tracking ───────────────────────────────────────────────────

export async function setPresence(userId: string, eventId?: string): Promise<void> {
  const redis = getRedis();
  const now = Date.now();

  // Global presence
  await redis.hSet('presence:global', userId, now.toString());

  // Event-scoped presence
  if (eventId) {
    await redis.zAdd(`presence:event:${eventId}`, { score: now, value: userId });
  }
}

export async function removePresence(userId: string, eventId?: string): Promise<void> {
  const redis = getRedis();

  await redis.hDel('presence:global', userId);

  if (eventId) {
    await redis.zRem(`presence:event:${eventId}`, userId);
  }
}

export async function isOnline(userId: string): Promise<boolean> {
  const redis = getRedis();
  const lastSeen = await redis.hGet('presence:global', userId);
  if (!lastSeen) return false;

  const elapsed = Date.now() - parseInt(lastSeen);
  return elapsed < 60_000; // 60-second window
}
