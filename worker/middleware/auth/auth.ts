/**
 * Authentication Middleware
 *
 * Delegates to the Supabase Auth adapter (`worker/services/auth/supabaseAuth.ts`)
 * for token verification. The hand-rolled JWT/session stack this used to
 * wrap (`AuthService`, `extractToken`) was retired in favor of
 * Supabase-issued session tokens - see supabaseAuth.ts for the token
 * extraction/verification details (Bearer header first, then the Supabase
 * auth cookie).
 */

import { AuthUserSession } from '../../types/auth-types';
import { createLogger } from '../../logger';
import { requireUser } from '../../services/auth/supabaseAuth';
import { UnauthorizedError } from 'shared/types/errors';

const logger = createLogger('AuthMiddleware');

/**
 * Authentication middleware
 *
 * Resolves the authenticated user for a request via Supabase Auth. Returns
 * `null` (never throws) on missing/invalid tokens, matching the contract
 * callers (`routeAuth.ts`'s `enforceAuthRequirement`,
 * `BaseController.getOptionalUser`) rely on. Supabase Auth owns session
 * lifecycle now - there is no separate server-issued session id - so
 * `sessionId` mirrors the user id to keep satisfying the `AuthUserSession`
 * shape that route auth and ticket auth expect.
 */
export async function authMiddleware(
    request: Request,
    env: Env
): Promise<AuthUserSession | null> {
    try {
        const user = await requireUser(env, request);
        logger.debug('User authenticated', { userId: user.id });
        return { user, sessionId: user.id };
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            logger.debug('No authentication found');
        } else {
            logger.error('Auth middleware error', error);
        }
        return null;
    }
}
