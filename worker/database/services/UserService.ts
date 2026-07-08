/**
 * User Service
 * Handles user profile and dashboard-facing database operations.
 *
 * Session management moved to Supabase Auth in phase 2a (see
 * `worker/services/auth/supabaseAuth.ts`) - the `sessions` table this
 * service used to own no longer exists in the lean Postgres schema, so the
 * old createSession/findValidSession/cleanupExpiredSessions methods were
 * dropped rather than ported.
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, and, sql, ne } from 'drizzle-orm';
import { generateId } from '../../utils/idGenerator';

/**
 * User Service Class
 */
export class UserService extends BaseService {

    // ========================================
    // USER MANAGEMENT
    // ========================================

    async createUser(userData: schema.NewUser): Promise<schema.User> {
        const [user] = await this.database
            .insert(schema.users)
            .values({ ...userData, id: generateId() })
            .returning();
        return user;
    }

    /**
     * User lookup method
     */
    async findUser(options: {
        id?: string;
        email?: string;
    }): Promise<schema.User | null> {
        const whereConditions = [
            options.id ? eq(schema.users.id, options.id) : undefined,
            options.email ? eq(schema.users.email, options.email) : undefined,
        ].filter(Boolean); // Remove undefined values

        if (whereConditions.length === 0) {
            return null;
        }

        const users = await this.database
            .select()
            .from(schema.users)
            .where(whereConditions.length === 1 ? whereConditions[0] : and(...whereConditions))
            .limit(1);

        return users[0] || null;
    }

    async updateUserActivity(userId: string): Promise<void> {
        await this.database
            .update(schema.users)
            .set({
                lastActiveAt: new Date(),
                updatedAt: new Date()
            })
            .where(eq(schema.users.id, userId));
    }

    // ========================================
    // USER PROFILE OPERATIONS
    // ========================================

    /**
     * Check if username is available
     */
    async isUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
        const existingUsers = await this.database
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(
                and(
                    eq(schema.users.username, username),
                    excludeUserId ? ne(schema.users.id, excludeUserId) : undefined
                )
            )
            .limit(1);

        return existingUsers.length === 0;
    }

    /**
     * Update user profile with comprehensive validation.
     *
     * Deferred in 2a: `bio`/`theme` are accepted as input (the frontend
     * still sends them) but not persisted - both columns were dropped in
     * the lean 7-table Postgres schema rewrite (see
     * `worker/database/schema.ts`) and have no replacement yet.
     */
    async updateUserProfileWithValidation(
        userId: string,
        profileData: {
            username?: string;
            displayName?: string;
            bio?: string;
            theme?: 'light' | 'dark' | 'system';
        }
    ): Promise<{ success: boolean; message: string }> {
        // Validate username if provided
        if (profileData.username) {
            const { username } = profileData;

            // Format validation
            if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
                return {
                    success: false,
                    message: 'Username can only contain letters, numbers, underscores, and hyphens'
                };
            }

            if (username.length < 3 || username.length > 30) {
                return {
                    success: false,
                    message: 'Username must be between 3 and 30 characters'
                };
            }

            // Check reserved usernames
            const reserved = ['admin', 'api', 'www', 'mail', 'ftp', 'root', 'support', 'help', 'about', 'terms', 'privacy'];
            if (reserved.includes(username.toLowerCase())) {
                return {
                    success: false,
                    message: 'Username is reserved'
                };
            }

            // Check uniqueness
            const existingUsers = await this.database
                .select({ id: schema.users.id })
                .from(schema.users)
                .where(eq(schema.users.username, username))
                .limit(1);
            const existingUser = existingUsers[0];

            if (existingUser && existingUser.id !== userId) {
                return {
                    success: false,
                    message: 'Username already taken'
                };
            }
        }

        // Update profile (bio/theme deferred in 2a - see method doc)
        await this.database
            .update(schema.users)
            .set({
                username: profileData.username || undefined,
                displayName: profileData.displayName || undefined,
                updatedAt: new Date()
            })
            .where(eq(schema.users.id, userId));

        return { success: true, message: 'Profile updated successfully' };
    }

    /**
     * Get basic user statistics efficiently
     */
    async getUserStatisticsBasic(userId: string): Promise<{ totalApps: number; appsThisMonth: number }> {
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const [totalAppsResult, appsThisMonthResult] = await Promise.all([
            // Total apps count
            this.database
                .select({ count: sql<number>`COUNT(*)` })
                .from(schema.apps)
                .where(eq(schema.apps.userId, userId)),

            // Apps created this month
            this.database
                .select({ count: sql<number>`COUNT(*)` })
                .from(schema.apps)
                .where(and(
                    eq(schema.apps.userId, userId),
                    sql`${schema.apps.createdAt} >= ${startOfMonth}`
                ))
        ]);

        return {
            totalApps: Number(totalAppsResult[0]?.count) || 0,
            appsThisMonth: Number(appsThisMonthResult[0]?.count) || 0
        };
    }

}
