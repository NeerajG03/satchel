// One answer to "am I inside the desktop shell?" so web behaviour never branches elsewhere.
export const isDesktop: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Registered with the operating system by the desktop shell and allow-listed in Supabase Auth.
export const desktopAuthCallback = 'satchel://auth/callback';

// Consent for agent connections stays on the hosted web app, never inside the shell.
export const hostedOrigin = 'https://satchel-pi.vercel.app';
