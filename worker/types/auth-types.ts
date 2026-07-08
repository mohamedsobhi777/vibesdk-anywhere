/**
 * Authentication Type Definitions
 */

/**
 * OAuth provider types
 */
export type OAuthProvider = 'google' | 'github';

/**
 * Authenticated user for middleware and session context
 */
export interface AuthUser {
	id: string;
	email: string;
	displayName?: string;
	username?: string;
	avatarUrl?: string;
    bio?: string;
    timezone?: string;
    provider?: string;
    emailVerified?: boolean;
    createdAt?: Date;
    isAnonymous?: boolean;
}

/**
 * Token payload structure for JWT tokens
 */
export interface TokenPayload {
	// Standard JWT claims
	sub: string; // User ID
	iat: number; // Issued at
	exp: number; // Expires at

	// Custom claims
	email: string;
	type: 'access' | 'refresh';
	jti?: string; // JWT ID (for refresh tokens)

	// Session context
	sessionId: string;

	// Security metadata
	ipHash?: string; // Hashed IP for security validation
}

export interface AuthUserSession {
    user: AuthUser;
    sessionId: string;
}

/**
 * OAuth provider user information
 */
export interface OAuthUserInfo {
	id: string;
	email: string;
	name?: string;
	picture?: string;
	emailVerified?: boolean;
	locale?: string;

	// Provider-specific data
	providerData?: Record<string, unknown>;
}

/**
 * OAuth tokens from provider
 */
export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	tokenType: string;
	expiresIn?: number;
	scope?: string;
}

/**
 * Password validation result with strength scoring
 */
export interface PasswordValidationResult {
	valid: boolean;
	errors?: string[];
	score: number; // 0-4 strength score

	// Detailed validation
	requirements?: {
		minLength: boolean;
		hasLowercase: boolean;
		hasUppercase: boolean;
		hasNumbers: boolean;
		hasSpecialChars: boolean;
		notCommon: boolean;
		noSequential: boolean;
	};

	// Suggestions for improvement
	suggestions?: string[];
}

/**
 * WebSocket ticket for secure, one-time-use authentication
 * Stored in Agent DO memory, consumed on WebSocket connection
 */
export interface PendingWsTicket {
	token: string;
	user: AuthUser;
	sessionId: string;
	createdAt: number;
	expiresAt: number;
}

/**
 * Result of ticket consumption from Agent DO
 */
export interface TicketConsumptionResult {
	user: AuthUser;
	sessionId: string;
}
