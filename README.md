# Pixel Pirates (v0.2, invoke-first)

Summon a crew of pixel pirates to plunder a page, or just one part of it. Move the mouse and
everything is restored.

## Install (dev)
1. `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> select this folder.
2. Serve `test-page.html` over http (`python3 -m http.server`) and open it.
3. Summon the pirates (below). Right-click the toolbar icon -> **Pirate settings** for options.

## Ways to invoke
| Action | What happens |
|---|---|
| Click toolbar icon | Raid the whole viewport. Click again to stop. |
| `Alt+Shift+P` | Same as the toolbar click (toggle). |
| `Alt+Shift+O` | **Pick mode**: hover to highlight, click to plunder just that element. Up/Down arrows grow/shrink the selection, Esc cancels. |
| Right-click page | "Send the pirates to plunder this page" / "Pick something to plunder..." |
| Surprise mode (opt-in) | Auto-raid after N idle seconds. Needs optional all-sites permission, granted from the settings page. |

Restoring: by default any mouse move (6px+), scroll, click or key restores the page. A settings option
switches to "click or key only" for screen recordings.

## Permissions (why the install warning is tiny)
- `activeTab` + `scripting`: the content script is injected only into the tab you invoke, only when you invoke it.
- `contextMenus`: right-click entries.
- `storage`: settings.
- `optional_host_permissions` (http/https): requested only if you enable Surprise mode, and removed when you disable it.

## How it works
| Piece | File | Notes |
|---|---|---|
| Invocation + injection | `background.js` | Toolbar/hotkey/menu -> messages the tab, injecting `content.js` + `styles.css` first if needed. Shows an "X" badge on pages that can't be scripted (chrome://, Web Store). |
| Raid engine | `content.js` | Ship, 4 pirates, cannons, particles on one closed-Shadow-DOM canvas (`pointer-events:none`). Sprites generated in code. |
| Pick mode | `content.js` `startPick()` | Highlight box + hint in a closed Shadow DOM; swallows page clicks while active. |
| Targeting | `content.js` `scan()` | Walks the DOM (or just the picked subtree), picks outermost small visible elements; big ones take 2-3 hits (scorched first). |
| Damage | `styles.css` | Only a `data-pp-state` attribute (`scorched`/`gone`/`restoring`). No nodes removed, no inline styles edited. |
| Restore | `endRaid()` | Fades back, then removes the attribute. Also fires on tab hide, `pagehide`, toggle-off, extension reload. |
| Settings | `options.html/js` | Crew mood, restore mode, optional idle mode (+ hostname blocklist). |

Activity listeners are attached only while a raid is running (or Surprise mode is on); an idle,
invoked-only install does nothing on any page.

## Known limitations / ideas
- Top frame only; iframes are hidden whole but not entered.
- Only the current viewport is raided.
- Framework re-renders that *replace* an element will bring it back mid-raid (attribute stripping is handled).
- Idea backlog: sound (opt-in), skins (ninjas/aliens), lifetime plunder stats, "raid in 5 minutes" prank timer, share/GIF capture.
