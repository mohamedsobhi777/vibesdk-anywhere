/**
 * Shared rate-limit types. Extracted from the former Durable-Object store so
 * the runtime-agnostic stores (Postgres on the Phoenix stack, KV on Workers)
 * can share the bucket/config/result shapes without importing a
 * `cloudflare:workers` Durable Object.
 */

export interface RateLimitBucket {
    count: number;
    timestamp: number;
}

export interface RateLimitState {
    buckets: Map<string, RateLimitBucket>;
    lastCleanup: number;
}

export interface RateLimitConfig {
    limit: number;
    period: number; // in seconds
    burst?: number;
    burstWindow?: number; // in seconds
    bucketSize?: number; // in seconds
    dailyLimit?: number; // max requests in a rolling 24h window
    /** If true, the main window is aligned to UTC calendar day (resets at midnight UTC) */
    calendarDaily?: boolean;
}

export interface RateLimitResult {
    success: boolean;
    remainingLimit?: number;
    exceededLimit?: 'main' | 'burst' | 'daily';
    limitValue?: number;
    periodSeconds?: number;
}
