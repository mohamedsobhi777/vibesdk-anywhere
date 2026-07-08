/**
 * Model Providers Service
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, and, sql } from 'drizzle-orm';
import { generateId } from '../../utils/idGenerator';

export interface CreateProviderData {
    name: string;
    baseUrl: string;
    secretId: string;
}

export interface UpdateProviderData {
    name?: string;
    baseUrl?: string;
    secretId?: string | null;
    isActive?: boolean;
}

export class ModelProvidersService extends BaseService {
    /**
     * Check if provider name exists for user
     */
    async providerExists(userId: string, name: string): Promise<boolean> {
        const existing = await this.database
            .select()
            .from(schema.userModelProviders)
            .where(
                and(
                    eq(schema.userModelProviders.userId, userId),
                    eq(schema.userModelProviders.name, name)
                )
            )
            .limit(1);

        return existing.length > 0;
    }

    /**
     * Create a new model provider
     */
    async createProvider(userId: string, data: CreateProviderData): Promise<schema.UserModelProvider> {
        const providerId = generateId();
        const provider = {
            id: providerId,
            userId,
            name: data.name,
            baseUrl: data.baseUrl,
            apiKeyEncrypted: data.secretId,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const [created] = await this.database
            .insert(schema.userModelProviders)
            .values(provider)
            .returning();

        return created;
    }

    /**
     * Get all providers for a user
     */
    async getUserProviders(userId: string): Promise<schema.UserModelProvider[]> {
        return await this.database
            .select()
            .from(schema.userModelProviders)
            .where(eq(schema.userModelProviders.userId, userId));
    }

    /**
     * Get a specific provider by ID
     */
    async getProvider(userId: string, providerId: string): Promise<schema.UserModelProvider | null> {
        const rows = await this.database
            .select()
            .from(schema.userModelProviders)
            .where(
                and(
                    eq(schema.userModelProviders.id, providerId),
                    eq(schema.userModelProviders.userId, userId)
                )
            )
            .limit(1);

        return rows[0] || null;
    }

    /**
     * Get a provider by name
     */
    async getProviderByName(userId: string, name: string): Promise<schema.UserModelProvider | null> {
        const rows = await this.database
            .select()
            .from(schema.userModelProviders)
            .where(
                and(
                    eq(schema.userModelProviders.userId, userId),
                    eq(schema.userModelProviders.name, name)
                )
            )
            .limit(1);

        return rows[0] || null;
    }

    /**
     * Update a provider
     */
    async updateProvider(
        userId: string, 
        providerId: string, 
        data: UpdateProviderData
    ): Promise<schema.UserModelProvider | null> {
        const { secretId, ...rest } = data;
        const updateData: Partial<typeof schema.userModelProviders.$inferInsert> = {
            ...rest,
            updatedAt: new Date()
        };
        if (secretId !== undefined) {
            updateData.apiKeyEncrypted = secretId;
        }

        const [updated] = await this.database
            .update(schema.userModelProviders)
            .set(updateData)
            .where(
                and(
                    eq(schema.userModelProviders.id, providerId),
                    eq(schema.userModelProviders.userId, userId)
                )
            )
            .returning();

        return updated || null;
    }

    /**
     * Delete a provider
     */
    async deleteProvider(userId: string, providerId: string): Promise<boolean> {
        const result = await this.database
            .delete(schema.userModelProviders)
            .where(
                and(
                    eq(schema.userModelProviders.id, providerId),
                    eq(schema.userModelProviders.userId, userId)
                )
            )
            .returning();

        return result.length > 0;
    }

    /**
     * Toggle provider active status
     */
    async toggleProviderStatus(userId: string, providerId: string): Promise<schema.UserModelProvider | null> {
        const provider = await this.getProvider(userId, providerId);
        if (!provider) {
            return null;
        }

        return await this.updateProvider(userId, providerId, {
            isActive: !provider.isActive
        });
    }

    /**
     * Get provider count for user
     */
    async getProviderCount(userId: string): Promise<number> {
        const result = await this.database
            .select({ count: sql<number>`count(*)` })
            .from(schema.userModelProviders)
            .where(eq(schema.userModelProviders.userId, userId));

        return result[0]?.count || 0;
    }
}
