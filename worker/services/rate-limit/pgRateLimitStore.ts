/**
 * Postgres rate-limit store - reproduces `DORateLimitStore`'s bucketed
 * sliding-window algorithm over the `rate_limit_buckets` table (see
 * `worker/database/schema.ts`).
 *
 * This is a behavioral drop-in for the retired-from-standalone
 * `DORateLimitStore` Durable Object: given the same `RateLimitConfig` and
 * the same sequence of calls, `increment`/`getRemainingLimit` here produce
 * the same `RateLimitResult`/remaining values the DO did. The DO kept
 * per-key buckets in a `Map` held in Durable Object memory (single-threaded
 * per key, so its check-then-write was race-free); here the same two
 * primitives - "increment a bucket" and "sum a window of buckets" - are
 * pushed into Postgres instead:
 *
 *   increment:  INSERT INTO rate_limit_buckets (key, bucket_timestamp, count)
 *               VALUES (...)
 *               ON CONFLICT (key, bucket_timestamp)
 *               DO UPDATE SET count = rate_limit_buckets.count + $incrementBy
 *
 *   window sum: SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets
 *               WHERE key = $1 AND bucket_timestamp >= $2 AND bucket_timestamp <= $3
 *
 * Concurrency note: unlike the DO (single-threaded per key), `increment`
 * here does a read (window sums) followed by a conditional write (the
 * UPSERT) as two separate round trips, not one transaction. Two concurrent
 * requests for the same key can both read a pre-increment count and both
 * pass the check, which the DO's in-memory single-threading could never do.
 * This mirrors the DO's check-then-write *order* exactly (so single-writer
 * behavior, and the tested scenarios in this task, match bit-for-bit) but
 * does not add cross-request locking - out of scope for reproducing the
 * window algorithm; a future hardening pass could wrap the read+write in a
 * serializable transaction or move the check into the UPSERT itself.
 *
 * `RateLimitConfig`/`RateLimitResult` are imported as types only from
 * `./DORateLimitStore` so this module never pulls in that file's
 * `cloudflare:workers` `DurableObject` import - the standalone agent
 * runtime (a plain Bun process, see `worker/database/pgConnection.ts`) has
 * no `cloudflare:workers` and must be able to load this module. For the
 * same reason `getStartOfUtcDay`/`MS_PER_DAY` are duplicated here rather
 * than imported (they are cheap, pure, three-line helpers).
 */

import { and, eq, gte, lte, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema';
import type { RateLimitConfig, RateLimitResult } from './types';

type Db = PostgresJsDatabase<typeof schema>;

/** Injectable "current time" - defaults to the real clock, overridden in tests. */
export type Clock = () => number;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_BUCKET_SIZE_SECONDS = 10;
const DEFAULT_BURST_WINDOW_SECONDS = 60;

/**
 * Duplicated from `DORateLimitStore.ts` rather than imported - see the
 * module header for why (avoids a runtime `cloudflare:workers` import).
 */
function getStartOfUtcDay(nowMs: number): number {
	return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

/** Floors a millisecond timestamp down to its bucket boundary. */
function alignToBucket(ms: number, bucketSizeMs: number): number {
	return Math.floor(ms / bucketSizeMs) * bucketSizeMs;
}

/**
 * Sums `count` over buckets for `key` whose `bucket_timestamp` falls in
 * `[windowStart, windowEnd]` (inclusive both ends). `windowStart` is
 * expected to already be bucket-aligned (see `alignToBucket`).
 *
 * This mirrors the DO's `getBucketsInRange`, which walks bucket-aligned
 * slots starting at `floor(startMs / bucketSizeMs) * bucketSizeMs` through
 * `endMs` inclusive - so a bucket whose window merely overlaps the
 * requested start is still counted in full. A literal
 * `bucket_timestamp > windowStart` (unaligned, strict) would silently
 * exclude that boundary bucket and undercount relative to the DO; using
 * `>=` against the aligned floor instead makes the two sums provably equal
 * for the same underlying bucket rows.
 *
 * `SUM(count)` over an `integer` column returns Postgres `bigint`, which
 * the `postgres` driver returns as a `string` by default (safe for values
 * beyond 2^53) - `Number(...)` converts it back explicitly rather than
 * relying on implicit coercion.
 */
async function windowSum(db: Db, key: string, windowStart: number, windowEnd: number): Promise<number> {
	const [row] = await db
		.select({ total: sql<string>`coalesce(sum(${schema.rateLimitBuckets.count}), 0)` })
		.from(schema.rateLimitBuckets)
		.where(
			and(
				eq(schema.rateLimitBuckets.key, key),
				gte(schema.rateLimitBuckets.bucketTimestamp, windowStart),
				lte(schema.rateLimitBuckets.bucketTimestamp, windowEnd),
			),
		);
	return Number(row?.total ?? 0);
}

/** Sums `count` over the rolling window `(now - windowMs, now]`, bucket-aligned at the lower bound. */
async function rollingWindowCount(db: Db, key: string, now: number, windowMs: number, bucketSizeMs: number): Promise<number> {
	const windowStart = alignToBucket(now - windowMs, bucketSizeMs);
	return windowSum(db, key, windowStart, now);
}

/**
 * Sums `count` over the main window: calendar-UTC-day-aligned when
 * `config.calendarDaily` is set (resets at UTC midnight), otherwise a
 * rolling window of `config.period` seconds - matching the DO's
 * `mainWindowStart` selection exactly.
 */
async function mainWindowCount(db: Db, key: string, now: number, config: RateLimitConfig, bucketSizeMs: number): Promise<number> {
	const windowStartRaw = config.calendarDaily ? getStartOfUtcDay(now) : now - config.period * 1000;
	const windowStart = alignToBucket(windowStartRaw, bucketSizeMs);
	return windowSum(db, key, windowStart, now);
}

/**
 * Upserts the bucket for `key` at `bucketTimestamp`, incrementing an
 * existing row's `count` by `incrementBy` or creating it at `incrementBy`
 * on first write - the same `(existing?.count ?? 0) + incrementBy`
 * semantics the DO's `Map.set` performed, but as a single atomic UPSERT so
 * concurrent writers to the same bucket never lose an increment.
 *
 * `createdAt` is set explicitly from the store's own clock (rather than
 * left to the column's `defaultNow()`) so a bucket's recorded creation
 * time always reflects the same "now" the rest of this call used - this
 * only matters for `cleanupExpiredBuckets`, and keeps that path testable
 * with an injected clock instead of real wall-clock sleeps. On conflict
 * only `count` is touched, so an existing bucket's original `createdAt` is
 * preserved.
 */
async function incrementBucket(db: Db, key: string, bucketTimestamp: number, incrementBy: number, createdAt: Date): Promise<void> {
	await db
		.insert(schema.rateLimitBuckets)
		.values({ key, bucketTimestamp, count: incrementBy, createdAt })
		.onConflictDoUpdate({
			target: [schema.rateLimitBuckets.key, schema.rateLimitBuckets.bucketTimestamp],
			set: { count: sql`${schema.rateLimitBuckets.count} + ${incrementBy}` },
		});
}

/**
 * Checks and increments the rate limit for `key`, mirroring
 * `DORateLimitStore#increment` exactly: main window is checked first, then
 * burst (if configured), then daily (if configured); the first exceeded
 * check wins and returns without writing anything. Only on success is the
 * current bucket incremented.
 *
 * `remainingLimit` is computed from the pre-increment counts minus this
 * call's `incrementBy`, same as the DO. The `config.dailyLimit &&` (deny
 * check) vs `config.dailyLimit != null` (remaining calculation) asymmetry
 * below is not a typo - it intentionally mirrors the DO's own asymmetric
 * checks so a `dailyLimit: 0` config produces the same (slightly odd:
 * never denies via the daily check, but still clamps `remaining` to 0)
 * behavior in both stores.
 */
export async function increment(
	db: Db,
	key: string,
	config: RateLimitConfig,
	incrementBy: number = 1,
	clock: Clock = Date.now,
): Promise<RateLimitResult> {
	const now = clock();
	const bucketSizeMs = (config.bucketSize ?? DEFAULT_BUCKET_SIZE_SECONDS) * 1000;
	const burstWindowMs = (config.burstWindow ?? DEFAULT_BURST_WINDOW_SECONDS) * 1000;

	const mainCount = await mainWindowCount(db, key, now, config, bucketSizeMs);
	if (mainCount >= config.limit) {
		return {
			success: false,
			remainingLimit: 0,
			exceededLimit: 'main',
			limitValue: config.limit,
			periodSeconds: config.period,
		};
	}

	let burstCount = 0;
	if (config.burst) {
		burstCount = await rollingWindowCount(db, key, now, burstWindowMs, bucketSizeMs);
		if (burstCount >= config.burst) {
			return {
				success: false,
				remainingLimit: 0,
				exceededLimit: 'burst',
				limitValue: config.burst,
				periodSeconds: config.burstWindow,
			};
		}
	}

	let dailyCount = 0;
	if (config.dailyLimit) {
		dailyCount = await rollingWindowCount(db, key, now, MS_PER_DAY, bucketSizeMs);
		if (dailyCount >= config.dailyLimit) {
			return {
				success: false,
				remainingLimit: 0,
				exceededLimit: 'daily',
				limitValue: config.dailyLimit,
				periodSeconds: MS_PER_DAY / 1000,
			};
		}
	}

	const currentBucket = alignToBucket(now, bucketSizeMs);
	await incrementBucket(db, key, currentBucket, incrementBy, new Date(now));

	const mainRemaining = config.limit - mainCount - incrementBy;
	const dailyRemaining = config.dailyLimit != null ? config.dailyLimit - dailyCount - incrementBy : undefined;
	const remaining = dailyRemaining != null ? Math.min(mainRemaining, dailyRemaining) : mainRemaining;

	return { success: true, remainingLimit: Math.max(0, remaining) };
}

/**
 * Read-only remaining-limit check (no increment), mirroring
 * `DORateLimitStore#getRemainingLimit` exactly.
 */
export async function getRemainingLimit(db: Db, key: string, config: RateLimitConfig, clock: Clock = Date.now): Promise<number> {
	const now = clock();
	const bucketSizeMs = (config.bucketSize ?? DEFAULT_BUCKET_SIZE_SECONDS) * 1000;

	const mainCount = await mainWindowCount(db, key, now, config, bucketSizeMs);
	const mainRemaining = config.limit - mainCount;

	if (config.dailyLimit) {
		const dailyCount = await rollingWindowCount(db, key, now, MS_PER_DAY, bucketSizeMs);
		const dailyRemaining = config.dailyLimit - dailyCount;
		return Math.max(0, Math.min(mainRemaining, dailyRemaining));
	}

	return Math.max(0, mainRemaining);
}

/**
 * Deletes buckets whose `created_at` is older than `retentionMs`. Mirrors
 * the DO's periodic sweep (`cleanup()`, run opportunistically every 5
 * minutes against `bucket.timestamp < now - maxWindow`), but as an
 * explicit operation a caller (e.g. a scheduled worker) invokes on its own
 * cadence: Postgres doesn't share the DO's original motivation (bounding
 * an in-memory `Map`'s size), only a table-growth motivation, so there is
 * no need to run this inline on every `increment` call.
 */
export async function cleanupExpiredBuckets(db: Db, retentionMs: number, clock: Clock = Date.now): Promise<void> {
	const cutoff = new Date(clock() - retentionMs);
	await db.delete(schema.rateLimitBuckets).where(lt(schema.rateLimitBuckets.createdAt, cutoff));
}
