import { setupAppRoutes } from './appRoutes';
import { setupUserRoutes } from './userRoutes';
import { setupAnalyticsRoutes } from './analyticsRoutes';
// import { setupUserSecretsRoutes } from './userSecretsRoutes';
import { setupModelConfigRoutes } from './modelConfigRoutes';
import { setupModelProviderRoutes } from './modelProviderRoutes';
import { setupGitHubExporterRoutes } from './githubExporterRoutes';
import { setupCodegenRoutes } from './codegenRoutes';
import { setupScreenshotRoutes } from './imagesRoutes';
import { setupSentryRoutes } from './sentryRoutes';
import { setupCapabilitiesRoutes } from './capabilitiesRoutes';
import { setupTicketRoutes } from './ticketRoutes';
import { setupLimitsRoutes } from './limitsRoutes';
import { Hono } from "hono";
import { AppEnv } from "../../types/appenv";
import { setupStatusRoutes } from './statusRoutes';

export function setupRoutes(app: Hono<AppEnv>): void {
    // Health check route
    app.get('/api/health', (c) => {
        return c.json({ status: 'ok' });
    });

    // Sentry tunnel routes (public - no auth required)
    setupSentryRoutes(app);

    // Platform status routes (public)
    setupStatusRoutes(app);

    // Platform capabilities routes (public)
    setupCapabilitiesRoutes(app);

    // Authentication is handled client-side by Supabase Auth as of phase 2a;
    // the hand-rolled register/login/OAuth/session/API-key routes that used
    // to live here were retired along with AuthService/SessionService/
    // ApiKeyService. Cloudflare "Connect" OAuth and account/gateway
    // management routes were retired with CloudflareAccountService (the
    // cloudflareAccounts/aiGateways tables are deferred).

    // WebSocket ticket routes
    setupTicketRoutes(app);

    // Codegen routes
    setupCodegenRoutes(app);

    // User dashboard and profile routes
    setupUserRoutes(app);

    // App management routes
    setupAppRoutes(app);

    // Stats routes were retired with AnalyticsService (depends on the
    // deferred favorites/appViews/appLikes tables).

    // AI Gateway Analytics routes
    setupAnalyticsRoutes(app);

    // // Secrets management routes (legacy D1-based)
    // setupSecretsRoutes(app);

    // // User secrets vault routes
    // setupUserSecretsRoutes(app);

    // Model configuration and provider keys routes
    setupModelConfigRoutes(app);

    // Model provider routes
    setupModelProviderRoutes(app);

    // GitHub Exporter routes
    setupGitHubExporterRoutes(app);

    // Screenshot serving routes (public)
    setupScreenshotRoutes(app);

    // Usage limits and free tier routes
    setupLimitsRoutes(app);
}
