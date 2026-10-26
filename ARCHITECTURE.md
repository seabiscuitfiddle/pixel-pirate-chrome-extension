# Architecture

## How it works
| Piece | File | Notes |
|---|---|---|
| Invocation + injection | `background.js` | Toolbar/hotkey/menu -> messages the tab, injecting `content.js` + `styles.css` first if needed. Shows an "X" badge on pages that can't be scripted (chrome://, Web Store). |
| Raid engine | `content.js` | Ship, 4 pirates, cannons, particles on one closed-Shadow-DOM canvas (`pointer-events:none`). Sprites generated in code. |
| Pick mode | `content.js` `startPick()` | Highlight box + hint in a closed Shadow DOM; swallows page clicks while active. |
| Targeting | `content.js` `scan()` | Walks the DOM (or just the picked subtree), picks outermost small visible elements; big ones take 2-3 hits (scorched first). |
| Damage | `styles.css` | Only a `data-pp-state` attribute (`scorched`/`gone`/`restoring`). No nodes removed, no inline styles edited. `gone` is instant; the overlay shows the shards or dragged copy. |
| Screenshot | `background.js` | `capture` message -> `captureVisibleTab` (JPEG) -> content script decodes with `createImageBitmap` (works under strict page CSP). |
| Restore | `endRaid()` | Fades back, then removes the attribute. Also fires on tab hide, `pagehide`, toggle-off, extension reload. |
| Settings | `options.html/js` | Crew mood, restore mode, optional idle mode (+ hostname blocklist). |

Activity listeners are attached only while a raid is running (or Surprise mode is on); an idle,
invoked-only install does nothing on any page.

## Known limitations
- Top frame only; iframes are hidden whole but not entered.
- Only the current viewport is raided.
- Framework re-renders that *replace* an element will bring it back mid-raid (attribute stripping is handled).
