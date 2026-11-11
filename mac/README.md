# Satchel for the Mac

A menu bar light and one key, from anywhere:

| Do this | What happens |
|---|---|
| Hold **right ⌥** on its own, talk, let go | A voice note on your Shelf |
| Double-tap **right ⌥**, talk, tap it again | The same, hands-free |
| **⌃⌥Space** | The panel opens: type, ⌘V or drop a picture, ⏎ saves |
| **⌘G** in the panel, drag a box, then hold right ⌥ | That part of the screen and what you said, as one drop |
| Click the mic in the panel | Starts listening; click again to save |
| Drag a picture, voice file, link or text onto the menu bar icon | Straight onto your Shelf |
| Esc | Cancels talking, or closes the panel |

Right ⌥ is also half of many shortcuts, so it only counts on its own: press another key or click while holding it, and nothing heard is kept. Hearing it while another app is in front needs Accessibility, which the panel asks for once.

While you talk with the panel closed, a small pill under the menu bar shows it listening, then amber while sending and green once it is on your Shelf. The light in the panel and the dot in the menu bar say what is still on this Mac: none when everything is on your Shelf, amber while sending, red when something could not be sent.

## Build

Needs only the Command Line Tools (macOS 14 or later). Reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from the environment or the repo's `.env`.

```bash
mac/build.sh
```

It installs `~/Applications/Satchel.app`. Open it once and sign in with Google; "Open at login" is in the menu.
