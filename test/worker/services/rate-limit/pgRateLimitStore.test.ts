import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from 'worker/database/schema';
import type { RateLimitConfig, RateLimitResult } from 'worker/services/rate-limit/types';

/**
 * `eq`/`and`/`gte`/`lte`/`lt`/`sql` normally compile to SQL fragments that
 * only a live Postgres connection can evaluate. To unit-test
 * `pgRateLimitStore`'s window math and UPSERT-increment behavior without
 * Docker/a real database, this file swaps them for JS-evaluable
 * predicates/markers that the fake db below applies directly against an
 * in-memory row array - the same technique
 * `test/worker/services/secrets/secretsStore.test.ts` established for
 * `eq`/`and`/`desc`, extended here to cover the range comparisons and the
 * raw `sql` UPSERT-increment/SUM expressions this store also needs.
 *
 * `pgRateLimitStore.ts` itself is unaffected: it calls the real
 * `drizzle-orm` exports and is typechecked against the real library - only
 * this test's module graph sees the fakes.
 */
const { fieldOf, makeFakeSql, isFakeSql, incrementAmountOf } = vi.hoisted(() => {
	const FIELD_BY_COLUMN_NAME: Record<string, string> = {
		key: 'key',
		bucket_timestamp: 'bucketTimestamp',
		count: 'count',
		created_at: 'createdAt',
	};

	function fieldOf(column: unknown): string {
		const name = (column as { name: string }).name;
		const field = FIELD_BY_COLUMN_NAME[name];
		if (!field) {
			throw new Error(`fake db: unmapped column "${name}"`);
		}
		return field;
	}

	interface FakeSqlExpr {
		readonly __fakeSql__: true;
		readonly values: unknown[];
	}

	function makeFakeSql(values: unknown[]): FakeSqlExpr {
		return { __fakeSql__: true, values };
	}

	function isFakeSql(value: unknown): value is FakeSqlExpr {
		return typeof value === 'object' && value !== null && '__fakeSql__' in value;
	}

	/** Extracts the increment amount from `sql\`${column} + ${incrementBy}\`` - the one numeric literal among the interpolated values. */
	function incrementAmountOf(expr: FakeSqlExpr): number {
		const numeric = expr.values.find((v): v is number => typeof v === 'number');
		if (numeric === undefined) {
			throw new Error('fake db: could not find increment amount in sql expression');
		}
		return numeric;
	}

	return { fieldOf, makeFakeSql, isFakeSql, incrementAmountOf };
});

vi.mock('drizzle-orm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('drizzle-orm')>();
	return {
		...actual,
		eq: (column: unknown, value: unknown) => (row: Record<string, unknown>) => row[fieldOf(column)] === value,
		and:
			(...conditions: Array<(row: Record<string, unknown>) => boolean>) =>
			(row: Record<string, unknown>) =>
				conditions.every((condition) => condition(row)),
		gte: (column: unknown, value: number) => (row: Record<string, unknown>) => (row[fieldOf(column)] as number) >= value,
		lte: (column: unknown, value: number) => (row: Record<string, unknown>) => (row[fieldOf(column)] as number) <= value,
		lt: (column: unknown, value: Date) => (row: Record<string, unknown>) => (row[fieldOf(column)] as Date).getTime() < value.getTime(),
		sql: (_strings: TemplateStringsArray, ...values: unknown[]) => makeFakeSql(values),
	};
});

import { cleanupExpiredBuckets, getRemainingLimit, increment } from 'worker/services/rate-limit/pgRateLimitStore';

/** In-memory shape of a `rate_limit_buckets` row (camelCase, matching `.values()`/select output). */
interface Row {
	key: string;
	bucketTimestamp: number;
	count: number;
	createdAt: Date;
}

type Predicate = (row: Row) => boolean;

/**
 * Minimal fake drizzle db: a real in-memory row array backs `insert`,
 * `select`, and `delete`. `.where()` genuinely filters (via the mocked
 * `eq`/`and`/`gte`/`lte`/`lt` predicates above), the UPSERT genuinely
 * reads-then-increments-or-creates a row keyed by `(key, bucketTimestamp)`
 * on conflict, and the SUM projection genuinely reduces over the filtered
 * rows - so the sliding-window math is actually exercised, not just
 * recorded.
 */
function createFakeDb() {
	const rows: Row[] = [];

	function findRow(key: string, bucketTimestamp: number): Row | undefined {
		return rows.find((row) => row.key === key && row.bucketTimestamp === bucketTimestamp);
	}

	function selectChain(projection: Record<string, unknown>) {
		let filtered: Row[] = rows;
		const chain = {
			from() {
				filtered = rows;
				return chain;
			},
			where(predicate: Predicate) {
				filtered = filtered.filter(predicate);
				return chain;
			},
			then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
				const [alias, expr] = Object.entries(projection)[0] ?? [];
				if (alias === undefined || !isFakeSql(expr)) {
					throw new Error('fake db: unsupported select projection');
				}
				const total = filtered.reduce((sum, row) => sum + row.count, 0);
				// Mimic postgres-js: SUM(integer) is Postgres `bigint`, returned as a string by default.
				return Promise.resolve([{ [alias]: String(total) }]).then(onFulfilled, onRejected);
			},
		};
		return chain;
	}

	function insertChain() {
		let pending: Row | undefined;
		const chain = {
			values(value: Record<string, unknown>) {
				pending = {
					key: value.key as string,
					bucketTimestamp: value.bucketTimestamp as number,
					count: value.count as number,
					createdAt: value.createdAt as Date,
				};
				return chain;
			},
			onConflictDoUpdate(config: { set: Record<string, unknown> }) {
				if (!pending) {
					throw new Error('fake db: onConflictDoUpdate called before values()');
				}
				const existing = findRow(pending.key, pending.bucketTimestamp);
				const setExpr = config.set.count;
				if (!isFakeSql(setExpr)) {
					throw new Error('fake db: unsupported onConflictDoUpdate set value');
				}
				if (existing) {
					existing.count += incrementAmountOf(setExpr);
				} else {
					rows.push({ ...pending });
				}
				return Promise.resolve();
			},
		};
		return chain;
	}

	function deleteChain() {
		const chain = {
			where(predicate: Predicate) {
				const toRemove = rows.filter(predicate);
				for (const row of toRemove) {
					const idx = rows.indexOf(row);
					if (idx >= 0) rows.splice(idx, 1);
				}
				return Promise.resolve();
			},
		};
		return chain;
	}

	return {
		select: (projection: Record<string, unknown>) => selectChain(projection),
		insert: () => insertChain(),
		delete: () => deleteChain(),
	};
}

function asDb(fake: ReturnType<typeof createFakeDb>): PostgresJsDatabase<typeof schema> {
	return fake as unknown as PostgresJsDatabase<typeof schema>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('pgRateLimitStore (postgres)', () => {
	describe('main window threshold', () => {
		it('allows increments up to the limit, then denies the next one - matching the DO threshold', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 3, period: 60, bucketSize: 10 };
			const key = 'user:a';
			const clock = () => 1_000_000;

			const r1 = await increment(db, key, config, 1, clock);
			const r2 = await increment(db, key, config, 1, clock);
			const r3 = await increment(db, key, config, 1, clock);
			const r4 = await increment(db, key, config, 1, clock);

			expect(r1).toEqual({ success: true, remainingLimit: 2 });
			expect(r2).toEqual({ success: true, remainingLimit: 1 });
			expect(r3).toEqual({ success: true, remainingLimit: 0 });
			expect(r4).toEqual({
				success: false,
				remainingLimit: 0,
				exceededLimit: 'main',
				limitValue: 3,
				periodSeconds: 60,
			});
		});
	});

	describe('window boundaries', () => {
		it('ignores buckets that have aged out of the window', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 2, period: 5, bucketSize: 1 };
			const key = 'user:b';

			const first = await increment(db, key, config, 1, () => 0);
			expect(first).toEqual({ success: true, remainingLimit: 1 });

			// 6s later: outside the 5s period window, so the first bucket must no longer count.
			const second = await increment(db, key, config, 1, () => 6000);
			// Not 0 - if the aged-out bucket were still counted, this would be denied or 0 remaining.
			expect(second).toEqual({ success: true, remainingLimit: 1 });
		});
	});

	describe('burst window', () => {
		it('denies once the burst threshold is hit even though the main window is far from exhausted', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 100, period: 60, burst: 2, burstWindow: 5, bucketSize: 1 };
			const key = 'user:c';
			const clock = () => 0;

			const r1 = await increment(db, key, config, 1, clock);
			const r2 = await increment(db, key, config, 1, clock);
			const r3 = await increment(db, key, config, 1, clock);

			expect(r1.success).toBe(true);
			expect(r2.success).toBe(true);
			expect(r3).toEqual({
				success: false,
				remainingLimit: 0,
				exceededLimit: 'burst',
				limitValue: 2,
				periodSeconds: 5,
			});
		});
	});

	describe('daily window', () => {
		it('denies once the rolling 24h daily count is reached, independent of the (much higher) main limit', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 1000, period: 60, dailyLimit: 2, bucketSize: 10 };
			const key = 'user:d';
			const clock = () => 0;

			const r1 = await increment(db, key, config, 1, clock);
			const r2 = await increment(db, key, config, 1, clock);
			const r3 = await increment(db, key, config, 1, clock);

			expect(r1.success).toBe(true);
			expect(r2.success).toBe(true);
			expect(r3).toEqual({
				success: false,
				remainingLimit: 0,
				exceededLimit: 'daily',
				limitValue: 2,
				periodSeconds: 24 * 60 * 60,
			});
		});
	});

	describe('calendar-day reset', () => {
		it('resets the main count at UTC midnight when calendarDaily is set, unlike an equivalent rolling window', async () => {
			const beforeMidnight = Date.UTC(2026, 0, 1, 23, 59, 50); // 2026-01-01T23:59:50Z
			const afterMidnight = Date.UTC(2026, 0, 2, 0, 0, 10); // 2026-01-02T00:00:10Z (20s later)

			const calendarConfig: RateLimitConfig = { limit: 1000, period: 24 * 60 * 60, calendarDaily: true, bucketSize: 10 };
			const rollingConfig: RateLimitConfig = { limit: 1000, period: 24 * 60 * 60, bucketSize: 10 };
			const key = 'user:e';

			const calendarDb = asDb(createFakeDb());
			const rollingDb = asDb(createFakeDb());

			await increment(calendarDb, key, calendarConfig, 1, () => beforeMidnight);
			await increment(rollingDb, key, rollingConfig, 1, () => beforeMidnight);

			const calendarAfter = await increment(calendarDb, key, calendarConfig, 1, () => afterMidnight);
			const rollingAfter = await increment(rollingDb, key, rollingConfig, 1, () => afterMidnight);

			// calendarDaily crossed into a new UTC day: the pre-midnight bucket no longer counts.
			expect(calendarAfter).toEqual({ success: true, remainingLimit: 999 });
			// the plain rolling 24h window still sees the 20-second-old bucket.
			expect(rollingAfter).toEqual({ success: true, remainingLimit: 998 });
		});
	});

	describe('getRemainingLimit', () => {
		it('reflects current usage without mutating state', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 5, period: 60, bucketSize: 10 };
			const key = 'user:f';
			const clock = () => 0;

			await increment(db, key, config, 1, clock);
			await increment(db, key, config, 2, clock);

			const remaining1 = await getRemainingLimit(db, key, config, clock);
			const remaining2 = await getRemainingLimit(db, key, config, clock);

			expect(remaining1).toBe(2); // 5 - (1 + 2)
			expect(remaining2).toBe(2); // read-only - calling it again changes nothing
		});
	});

	describe('cleanupExpiredBuckets', () => {
		it('deletes buckets older than the retention window, and the deletion is reflected in later window queries', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 10, period: 100 * 24 * 60 * 60, bucketSize: 10 };
			const key = 'user:g';

			await increment(db, key, config, 1, () => 0);

			const laterClock = () => 50 * DAY_MS;
			const beforeCleanup = await getRemainingLimit(db, key, config, laterClock);
			expect(beforeCleanup).toBe(9); // old bucket still inside the 100-day window

			await cleanupExpiredBuckets(db, 10 * DAY_MS, laterClock);

			const afterCleanup = await getRemainingLimit(db, key, config, laterClock);
			expect(afterCleanup).toBe(10); // old bucket pruned - no longer counted
		});

		it('leaves buckets newer than the retention window untouched', async () => {
			const db = asDb(createFakeDb());
			const config: RateLimitConfig = { limit: 10, period: 100 * 24 * 60 * 60, bucketSize: 10 };
			const key = 'user:h';

			await increment(db, key, config, 1, () => 0);
			await cleanupExpiredBuckets(db, 10 * DAY_MS, () => 5 * DAY_MS); // cutoff is -5 days, bucket is at 0: not stale yet

			const remaining = await getRemainingLimit(db, key, config, () => 5 * DAY_MS);
			expect(remaining).toBe(9); // still counted - nothing was pruned
		});
	});

	describe('DO parity', () => {
		/**
		 * Direct transcription of `DORateLimitStore#increment`'s pure
		 * arithmetic (worker/services/rate-limit/DORateLimitStore.ts:55-133),
		 * operating over a local in-memory bucket map instead of Durable
		 * Object storage. Used only as a test oracle to cross-check the
		 * Postgres store's allow/deny decisions against the original
		 * algorithm, call for call, without depending on `cloudflare:workers`
		 * (which the real DO class requires to construct).
		 */
		function createDoOracle() {
			const buckets = new Map<string, { count: number; timestamp: number }>();

			function getBucketsInRange(key: string, startMs: number, endMs: number, bucketSizeMs: number) {
				const result: { count: number; timestamp: number }[] = [];
				for (let time = Math.floor(startMs / bucketSizeMs) * bucketSizeMs; time <= endMs; time += bucketSizeMs) {
					const bucket = buckets.get(`${key}:${time}`);
					if (bucket) result.push(bucket);
				}
				return result;
			}

			function increment(key: string, config: RateLimitConfig, now: number, incrementBy = 1): RateLimitResult {
				const bucketSize = (config.bucketSize || 10) * 1000;
				const burstWindow = (config.burstWindow || 60) * 1000;
				const mainWindow = config.period * 1000;
				const dailyWindow = config.dailyLimit ? DAY_MS : 0;
				const mainWindowStart = config.calendarDaily ? Math.floor(now / DAY_MS) * DAY_MS : now - mainWindow;
				const currentBucket = Math.floor(now / bucketSize) * bucketSize;
				const bucketKey = `${key}:${currentBucket}`;

				const mainBuckets = getBucketsInRange(key, mainWindowStart, now, bucketSize);
				const burstBuckets = config.burst ? getBucketsInRange(key, now - burstWindow, now, bucketSize) : [];
				const dailyBuckets = config.dailyLimit ? getBucketsInRange(key, now - dailyWindow, now, bucketSize) : [];

				const mainCount = mainBuckets.reduce((sum, b) => sum + b.count, 0);
				const burstCount = burstBuckets.reduce((sum, b) => sum + b.count, 0);
				const dailyCount = dailyBuckets.reduce((sum, b) => sum + b.count, 0);

				if (mainCount >= config.limit) {
					return { success: false, remainingLimit: 0, exceededLimit: 'main', limitValue: config.limit, periodSeconds: config.period };
				}
				if (config.burst && burstCount >= config.burst) {
					return { success: false, remainingLimit: 0, exceededLimit: 'burst', limitValue: config.burst, periodSeconds: config.burstWindow };
				}
				if (config.dailyLimit && dailyCount >= config.dailyLimit) {
					return { success: false, remainingLimit: 0, exceededLimit: 'daily', limitValue: config.dailyLimit, periodSeconds: 24 * 60 * 60 };
				}

				const existing = buckets.get(bucketKey);
				buckets.set(bucketKey, { count: (existing?.count || 0) + incrementBy, timestamp: now });

				const mainRemaining = config.limit - mainCount - incrementBy;
				const dailyRemaining = config.dailyLimit != null ? config.dailyLimit - dailyCount - incrementBy : undefined;
				const remaining = dailyRemaining != null ? Math.min(mainRemaining, dailyRemaining) : mainRemaining;

				return { success: true, remainingLimit: Math.max(0, remaining) };
			}

			return { increment };
		}

		it('matches DORateLimitStore#increment call-for-call across a mixed main+burst+daily schedule', async () => {
			const db = asDb(createFakeDb());
			const oracle = createDoOracle();
			const config: RateLimitConfig = {
				limit: 6,
				period: 3600,
				burst: 3,
				burstWindow: 10,
				dailyLimit: 5,
				bucketSize: 5,
			};
			const key = 'user:parity';

			const schedule: Array<{ t: number; by: number }> = [
				{ t: 0, by: 1 },
				{ t: 1000, by: 1 },
				{ t: 2000, by: 1 },
				{ t: 20000, by: 1 },
				{ t: 25000, by: 1 },
				{ t: 30000, by: 1 },
				{ t: 35000, by: 1 },
			];

			const results: RateLimitResult[] = [];
			for (const { t, by } of schedule) {
				const pgResult = await increment(db, key, config, by, () => t);
				const oracleResult = oracle.increment(key, config, t, by);
				expect(pgResult).toEqual(oracleResult);
				results.push(pgResult);
			}

			// Independently hand-derived (not just "whatever the oracle says"):
			// by t=30000 five prior calls have succeeded, so the rolling 24h
			// daily count (limit 5) is exhausted and this 6th call - and the
			// next - must be denied on the daily check specifically, with the
			// main window (limit 6) nowhere near exhausted (5 < 6 there).
			expect(results[5]).toEqual({
				success: false,
				remainingLimit: 0,
				exceededLimit: 'daily',
				limitValue: 5,
				periodSeconds: 24 * 60 * 60,
			});
			expect(results[6].success).toBe(false);
			expect(results[6].exceededLimit).toBe('daily');
		});
	});
});
