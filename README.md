# Pixel Pirates (v0.3)

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

## Destruction and looting
- **Cannon kills shatter the element.** It breaks into jittered triangular shards (cut from the real pixels)
  that fly away from the impact point, tumble, and fall. Elements that were already charred shatter into charred shards;
  big elements lose a few chips on the first hit.
- **Looting drags the real element.** A pirate swings out, hooks the element, and hauls it back to the ship on a
  rope. It sways behind the pirate, shrinks as it's pulled up, and is stowed behind the ship's rail.
- **How it gets the pixels:** at raid start the extension takes one screenshot of the visible tab (`activeTab` +
  `captureVisibleTab`) before the overlay is drawn, then crops each element out of it. The image stays in memory,
  is never sent anywhere, and is discarded when the raid ends. If the capture fails (rate limit, restricted page,
  no permission), painted stand-ins are used instead, so everything still works.

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
| Damage | `styles.css` | Only a `data-pp-state` attribute (`scorched`/`gone`/`restoring`). No nodes removed, no inline styles edited. `gone` is instant; the overlay shows the shards or dragged copy. |
| Screenshot | `background.js` | `capture` message -> `captureVisibleTab` (JPEG) -> content script decodes with `createImageBitmap` (works under strict page CSP). |
| Restore | `endRaid()` | Fades back, then removes the attribute. Also fires on tab hide, `pagehide`, toggle-off, extension reload. |
| Settings | `options.html/js` | Crew mood, restore mode, optional idle mode (+ hostname blocklist). |

Activity listeners are attached only while a raid is running (or Surprise mode is on); an idle,
invoked-only install does nothing on any page.

## Known limitations / ideas
- Top frame only; iframes are hidden whole but not entered.
- Only the current viewport is raided.
- Framework re-renders that *replace* an element will bring it back mid-raid (attribute stripping is handled).
- Idea backlog: sound (opt-in), skins (ninjas/aliens), lifetime plunder stats, "raid in 5 minutes" prank timer, share/GIF capture.
