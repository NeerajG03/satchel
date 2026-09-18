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
| Memory, tasks, projects and apps pages load and save | Verified | User saved a memory from the shell; Left off, Book and Apps rendered live data |
| External links open in the browser, not inside the shell | Verified | Sign-in link opened the default browser through the opener plugin |
| Window size and position persist across relaunch | Verified | Relaunch restored a user-resized 1512×949 window |
| Second launch focuses the existing window | Verified | Second `open` left one process running |

| Header and rail stay fixed; only the paper scrolls | Verified | User confirmed on the Apps and Book pages |
| Popovers stay inside the scrolling paper | Verified | Scope picker opens fully after anchoring it to the left |
| Unsigned DMG built by the Desktop workflow on a macOS runner | Pending | Tag `desktop-v0.1.0` pushed; see the release |

## Not covered

- Notarization and Gatekeeper behaviour on another Mac.
- Intel builds. Only `aarch64-apple-darwin` is built.
- Automatic updates.
