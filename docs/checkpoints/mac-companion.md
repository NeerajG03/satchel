# Mac companion checkpoint

18 September 2026. Evidence for the first desktop build. Items marked pending have not been exercised against the built app yet. The URL scheme is confirmed registered with Launch Services.

| Check | Result | Evidence |
|---|---|---|
| Rust toolchain and Tauri CLI install on Apple Silicon without Xcode | Verified | rustup minimal profile, `tauri-cli 2.11.4` |
| `npm test` and `npm run build:desktop` pass with the shell code | Verified | 79 tests pass; bundle uses relative asset paths |
| `npx tauri build` produces `Satchel.app` and a DMG | Verified | `Satchel_0.1.0_aarch64.dmg` built locally on Apple Silicon |
| App opens to the welcome page with the notebook theme and app icon | Verified | Window titled Satchel at 1100×760; screenshot from the user |
| Continue with GitHub opens the default browser | Verified | User completed sign-in in the browser |
| `satchel://auth/callback` returns to the app and signs in | Verified | User signed in; Left off page showed synced tasks, memory and apps |
| Memory, tasks, projects and apps pages load | Verified for load | Left off page rendered live data. Saves not yet exercised in the shell |
| External links open in the browser, not inside the shell | Pending | |
| Window size and position persist across relaunch | Pending | |
| Second launch focuses the existing window | Verified | Second `open` left one process running |

## Not covered

- Notarization and Gatekeeper behaviour on another Mac.
- Intel builds. Only `aarch64-apple-darwin` is built.
- Automatic updates.
