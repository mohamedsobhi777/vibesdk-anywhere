/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL: string;
    readonly VITE_SUPABASE_ANON_KEY: string;
    // Show the Google/GitHub sign-in buttons. Off unless set to 'true' — enable
    // only after configuring the provider in the Supabase dashboard.
    readonly VITE_AUTH_GOOGLE?: string;
    readonly VITE_AUTH_GITHUB?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
