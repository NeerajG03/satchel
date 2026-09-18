# Mac companion

Updated 18 September 2026. The Mac app is the hosted web companion bundled inside a native shell. Same React code, same Supabase project, same row-level security. Nothing here adds capabilities the web app lacks yet; it is the base the recorder and dictation work will stand on.

## What it is

| Part | Where | Notes |
|---|---|---|
| Native shell | `src-tauri/` | Tauri 2. Registers the `satchel://` URL scheme, opens links in the default browser, keeps one instance and remembers window position |
| Web build | `npm run build:desktop` | Vite with a relative base so `index.html` loads from inside the app bundle |
| Platform switch | `src/platform.ts` | The only place that answers "am I in the desktop shell". Everything else branches on it |
| Desktop sign-in | `src/desktopAuth.ts` | Browser-based GitHub sign-in that returns through `satchel://auth/callback` |

The desktop shell uses hash routing because it serves the app from a bundled file, not a web server. The hosted web app keeps path routing. Both come from the same `src/app/routes.tsx`.

## Sign-in

The web app redirects GitHub back to its own origin. A desktop app has no web origin, so the shell does this instead:

1. Continue with GitHub opens the Supabase authorize URL in the user's default browser, where GitHub is usually already signed in.
2. Supabase redirects to `satchel://auth/callback?code=…`. macOS routes that to the running app.
3. The app exchanges the PKCE code for a session. The verifier lives in the webview's storage between steps 1 and 3.

`satchel://auth/callback` must be in Supabase Authentication → URL Configuration → Redirect URLs. The Supabase client turns off URL session detection in the shell because the code never appears in the page URL.

Agent consent (`/apps/consent`) stays on the hosted web app. A `satchel://` link carrying an `authorization_id` is forwarded to the hosted origin in the browser. The desktop shell is not an OAuth return address for agents.

## Building

```sh
npm ci
npm run desktop        # dev mode with live reload
npm run desktop:build  # Satchel.app and a DMG under src-tauri/target/release/bundle
```

Rust is required: install with rustup. Xcode Command Line Tools are enough; full Xcode is not needed. Public browser values in `.env` or `.env.local` are baked into the bundle at build time.

## Distribution

Builds are unsigned and not notarized. There is no Apple Developer account behind them. The `Desktop` workflow builds a DMG on a macOS runner when a `desktop-v*` tag is pushed and attaches it to a GitHub release.

First launch on any Mac: right-click Satchel.app, choose Open, then Open again in the dialog. macOS remembers the choice. Alternatively:

```sh
xattr -d com.apple.quarantine /Applications/Satchel.app
```

Updates are manual for the pilot: download the next DMG and replace the app. Sign-in state is kept in the app's own storage and survives replacement.

## Verified and not verified

See the [Mac companion checkpoint](checkpoints/mac-companion.md) for what has been checked against the real build.

## Later

Microphone capture, local transcription and dictation are separate work with their own design. They will live in the native layer of this shell and store text through the same Supabase client. See the discussion history for the direction.
