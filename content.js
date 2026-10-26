/* Pixel Pirates - content script (v0.2: invoked, not ambient)
 *
 * Injected on demand by background.js (activeTab). Responds to messages:
 *   invoke     toggle: start a page raid, or stop the current raid / pick
 *   raid-page  start a page raid
 *   pick       let the user click an element, then raid just that element
 * If the user opted into idle mode, the same script is registered on all sites and also
 * starts raids by itself after a period of inactivity.
 *
 * Safety rules:
 *  - Page elements are only touched via the data-pp-state attribute (see styles.css).
 *    No node is removed and no inline style is edited.
 *  - Everything drawn lives in a closed Shadow DOM with pointer-events: none.
 *  - Activity listeners are only attached while a raid is running (or idle mode is on).
 *  - Restore runs on activity, tab hide, pagehide, and extension reload.
 */
(() => {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__pixelPirates && window.__pixelPirates.alive()) return; // already loaded and live
  window.__pixelPirates = {
    alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } },
  };

  // ---------------------------------------------------------------- settings
  const DEFAULTS = {
    speed: 3,                 // 1 (lazy crew) .. 5 (mutiny)
    restoreOn: 'move',        // 'move' = mouse move, key, click, scroll | 'click' = click or key only
    idleEnabled: false,       // opt-in automatic raids
    idleSeconds: 45,
    respectReducedMotion: true,
    disabledHosts: [],
  };
  let settings = { ...DEFAULTS };

  // Idle mode never auto-starts on hostnames containing any of these.
  const DENY_SUBSTRINGS = [
    'bank', 'paypal', 'venmo', 'chase.com', 'wellsfargo', 'citi.com', 'capitalone',
    'americanexpress', 'schwab', 'fidelity.com', 'vanguard', 'robinhood', 'coinbase',
    'mail.google.com', 'outlook.live.com', 'outlook.office', 'mail.yahoo', 'proton.me',
    'docs.google.com', 'sheets.google.com', 'slides.google.com', 'drive.google.com',
    'figma.com', 'notion.so', 'mychart', '.gov', 'healthcare',
    'login.', 'accounts.', 'signin.', 'auth.',
  ];

  const STATE_ATTR = 'data-pp-state';
  const PICK_ATTR = 'data-pp-picking';
  const SHIP_W = 30, SHIP_H = 24, SHIP_PX = 7;
  const PIRATE_W = 16, PIRATE_H = 24, PIRATE_PX = 3;
  const MAX_PARTICLES = 600;
  const MAX_SHARDS = 700;
  const HOST_CSS =
    'all:initial!important;position:fixed!important;top:0!important;left:0!important;' +
    'width:100%!important;height:100%!important;z-index:2147483647!important;' +
    'pointer-events:none!important;display:block!important;';

  // ----------------------------------------------------------------- helpers
  const now = () => performance.now();
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const alive = () => window.__pixelPirates && window.__pixelPirates.alive();

  // --------------------------------------------------------------- app state
  let mode = 'idle';            // 'idle' | 'picking' | 'raiding'
  let raid = null;
  let pickState = null;
  let lastActivity = now();
  let graceUntil = 0;
  let lastMouse = null;
  let ticker = null;
  let listening = false;
  let raidToken = 0;            // invalidates a raid that is still waiting for its screenshot

  let host = null, canvas = null, ctx = null, W = 0, H = 0;
  let S = null;                 // sprites

  // ---------------------------------------------------------------- settings IO
  try {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      if (chrome.runtime.lastError || !s) return;
      settings = { ...DEFAULTS, ...s };
      syncIdleMode();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k in changes) settings[k] = changes[k].newValue ?? DEFAULTS[k];
      if (!settings.idleEnabled && raid && !raid.manual) endRaid(false);
      syncIdleMode();
    });
  } catch (_) { /* extension context gone */ }

  // ------------------------------------------------------------ block checks (idle mode only)
  function siteBlocked() {
    const h = location.hostname.toLowerCase();
    if ((settings.disabledHosts || []).some((d) => d && h.includes(String(d).toLowerCase()))) return true;
    return DENY_SUBSTRINGS.some((s) => h.includes(s));
  }

  function isEditing() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME' || a.isContentEditable;
  }

  function mediaPlaying() {
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused && !m.ended && m.readyState > 2 && !m.muted && m.volume > 0) return true;
    }
    return false;
  }

  function hasVisiblePassword() {
    const el = document.querySelector('input[type="password"]');
    return !!(el && el.offsetParent !== null);
  }

  function autoBlocked() {
    if (document.hidden) return true;
    if (document.fullscreenElement || document.pictureInPictureElement) return true;
    if (siteBlocked()) return true;
    if (isEditing() || mediaPlaying() || hasVisiblePassword()) return true;
    if (settings.respectReducedMotion && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    return false;
  }

  // ---------------------------------------------------------- activity input
  const markActive = () => { lastActivity = now(); };

  function onMouseMove(e) {
    if (!e.isTrusted) return;
    const prev = lastMouse;
    lastMouse = { x: e.clientX, y: e.clientY };
    if (!prev) { if (mode === 'idle') markActive(); return; } // first event only sets a baseline
    const moved = Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    if (mode === 'raiding') {
      // Chrome fires synthetic mousemoves after layout changes; those have moved === 0.
      if (raid && raid.restoreOn === 'move' && moved >= 6 && now() > graceUntil) endRaid(false);
    } else if (mode === 'idle' && moved >= 1) {
      markActive();
    }
  }

  function onOtherActivity(e) {
    if (!e.isTrusted) return;
    if (mode === 'raiding') {
      if (now() <= graceUntil || !raid) return;
      const strong = e.type === 'mousedown' || e.type === 'pointerdown' || e.type === 'keydown' || e.type === 'touchstart';
      if (strong || raid.restoreOn === 'move') endRaid(false);
    } else if (mode === 'idle') {
      markActive();
    }
  }

  function onScroll() {
    if (mode === 'raiding') {
      if (raid && raid.restoreOn === 'move' && Math.abs(window.scrollY - raid.scrollY) >= 2 && now() > graceUntil) endRaid(false);
    } else if (mode === 'idle') {
      markActive();
    }
  }

  const onVisibility = () => { if (document.hidden) endRaid(true); };
  const onPageHide = () => { endRaid(true); };

  const listeners = [
    [window, 'mousemove', onMouseMove],
    [window, 'mousedown', onOtherActivity],
    [window, 'keydown', onOtherActivity],
    [window, 'wheel', onOtherActivity],
    [window, 'touchstart', onOtherActivity],
    [window, 'pointerdown', onOtherActivity],
    [window, 'scroll', onScroll],
    [document, 'visibilitychange', onVisibility],
    [window, 'pagehide', onPageHide],
  ];

  // Only listen while a raid is running or idle mode is enabled.
  function syncListeners() {
    const want = settings.idleEnabled || mode === 'raiding';
    if (want && !listening) {
      for (const [t, ev, fn] of listeners) t.addEventListener(ev, fn, { capture: true, passive: true });
      listening = true;
    } else if (!want && listening) {
      for (const [t, ev, fn] of listeners) t.removeEventListener(ev, fn, { capture: true });
      listening = false;
    }
  }

  // ------------------------------------------------------------ idle ticker (opt-in)
  function syncIdleMode() {
    if (settings.idleEnabled && !ticker) {
      lastActivity = now();
      ticker = setInterval(tick, 1000);
    } else if (!settings.idleEnabled && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    syncListeners();
  }

  function tick() {
    if (!alive()) { shutdown(); return; }
    if (mode !== 'idle' || !settings.idleEnabled) return;
    if (now() - lastActivity < settings.idleSeconds * 1000) return;
    if (autoBlocked()) { markActive(); return; } // blocked state counts as "not really idle"
    startRaid({ manual: false, root: null });
  }

  function shutdown() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    cancelPick();
    endRaid(true);
    settings.idleEnabled = false;
    syncListeners();
  }

  // ---------------------------------------------------------------- messages
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      switch (msg.type) {
        case 'invoke':
          if (mode === 'raiding') endRaid(false);
          else if (mode === 'picking') cancelPick();
          else startRaid({ manual: true, root: null });
          break;
        case 'raid-page':
          cancelPick();
          if (mode === 'raiding') endRaid(true);
          startRaid({ manual: true, root: null });
          break;
        case 'pick':
          if (mode === 'picking') cancelPick();
          else startPick();
          break;
        default:
          return false;
      }
      sendResponse({ ok: true });
      return false;
    });
  } catch (_) { /* ignore */ }

  // ------------------------------------------------------------------ sprites
  function makeSprite(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'));
    return c;
  }

  function fromRows(rows, palette) {
    return makeSprite(rows[0].length, rows.length, (g) => {
      rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          const col = palette[row[x]];
          if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
        }
      });
    });
  }

  function getSprites() {
    if (S) return S;

    const ship = makeSprite(SHIP_W, SHIP_H, (g) => {
      const R = (c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
      R('#5a3418', 14, 3, 2, 15);                                   // mast
      R('#1a1a1a', 16, 0, 8, 5);                                    // flag
      R('#f2efe6', 18, 1, 1, 1); R('#f2efe6', 21, 1, 1, 1);         // skull eyes
      R('#f2efe6', 19, 3, 3, 1);                                    // skull teeth
      R('#e8e2cf', 4, 5, 10, 10); R('#d2cbb2', 16, 6, 9, 9);        // sails
      R('#c0392b', 4, 9, 10, 1);  R('#c0392b', 16, 10, 9, 1);       // red stripes
      R('#b9b199', 4, 14, 10, 1); R('#b9b199', 16, 14, 9, 1);       // sail shading
      R('#5a3418', 3, 15, 12, 1); R('#5a3418', 15, 15, 11, 1);      // booms
      R('#8b5a2b', 1, 17, 28, 1);                                   // rail
      R('#d4a017', 2, 18, 26, 1);                                   // gold stripe
      R('#6e4522', 3, 19, 24, 1);
      R('#5a3418', 4, 20, 22, 1);
      R('#6e4522', 6, 21, 18, 1);
      R('#5a3418', 8, 22, 14, 1);
      R('#3d2410', 11, 23, 8, 1);
      R('#1a1a1a', 8, 19, 2, 2); R('#1a1a1a', 14, 19, 2, 2); R('#1a1a1a', 20, 19, 2, 2); // cannon ports
    });

    const pal = { k: '#1a1a1a', w: '#f2efe6', s: '#f0c08a', S: '#d49a62', r: '#c0392b', R: '#8e2a20', n: '#2c3e8f', b: '#5a3418', y: '#f1c40f', d: '#3b2314' };
    const top = [
      '....kkkkkkkk....',
      '..kkkkkkkkkkkk..',
      '.kkkkkwwwwkkkkk.',
      'kkkkkkwkkwkkkkkk',
      '.kkkkkkwwkkkkkk.',
      '..kyyyyyyyyyyk..',
      '...kssssssssk...',
      '...kkkkkssksk...',
      '...ksssSsssSk...',
      '...kdssrrssdk...',
      '...kddddddddk...',
      '....kddddddk....',
      '..kkrrkddkrrkk..',
      '.krrrwwrrwwrrrk.',
      'ksrRrwwrrwwrRrsk',
      'kskrrrrrrrrrrksk',
      '..krrwwrrwwrrk..',
      '..kbbbbyybbbbk..',
      '..knnnnnnnnnnk..',
      '..knnnnkknnnnk..'
    ];
    const pirateA = fromRows([...top,
      '..knnnk..knnnk..',
      '..knnnk..knnnk..',
      '..kbbbk..kbbbk..',
      '.kkbbbk..kbbbkk.'
    ], pal);
    const pirateB = fromRows([...top,
      '.knnnk....knnnk.',
      '.knnnk....knnnk.',
      '.kbbbk....kbbbk.',
      'kkbbbk....kbbbkk'
    ], pal);
    S = { ship, pirateA, pirateB };
    return S;
  }

  // ------------------------------------------------------------------ overlay
  function createOverlay() {
    host = document.createElement('pixel-pirates-overlay');
    host.style.cssText = HOST_CSS;
    const root = host.attachShadow({ mode: 'closed' });
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';
    root.appendChild(canvas);
    document.documentElement.appendChild(host);
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function teardownOverlay(immediate) {
    const h = host;
    host = null; canvas = null; ctx = null;
    window.removeEventListener('resize', resize);
    if (!h) return;
    if (immediate) { h.remove(); return; }
    h.style.setProperty('transition', 'opacity .25s', 'important');
    void h.offsetWidth; // force reflow so the transition runs
    h.style.setProperty('opacity', '0', 'important');
    setTimeout(() => h.remove(), 320);
  }

  // ------------------------------------------------------------- pick mode
  // Hover to highlight, click to plunder. Up/Down arrows grow/shrink the selection, Esc cancels.
  function startPick() {
    if (mode === 'raiding') endRaid(true);
    if (mode !== 'idle') return;
    mode = 'picking';

    const h = document.createElement('pixel-pirates-pick');
    h.style.cssText = HOST_CSS;
    const root = h.attachShadow({ mode: 'closed' });

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;display:none;box-sizing:border-box;border:2px dashed #f1c40f;background:rgba(241,196,15,.18);pointer-events:none;';
    const tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;left:-2px;top:-22px;background:#0f2540;color:#f1c40f;font:12px "Courier New",monospace;padding:2px 6px;white-space:nowrap;';
    box.appendChild(tag);

    const hint = document.createElement('div');
    hint.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#0f2540;color:#f2efe6;border:3px solid #d4a017;font:14px "Courier New",monospace;padding:8px 14px;text-align:center;max-width:90vw;';
    hint.textContent = 'PICK A TARGET \u2022 click to plunder \u2022 \u2191/\u2193 resize selection \u2022 Esc to cancel';

    root.append(box, hint);
    document.documentElement.appendChild(h);
    document.documentElement.setAttribute(PICK_ATTR, '');

    const ps = pickState = { host: h, box, tag, candidate: null, stack: [], x: -1, y: -1, handlers: [] };

    const setCandidate = (el) => {
      ps.candidate = el;
      if (!el) { box.style.display = 'none'; return; }
      const rc = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = rc.left + 'px';
      box.style.top = rc.top + 'px';
      box.style.width = rc.width + 'px';
      box.style.height = rc.height + 'px';
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
      tag.textContent = `${el.tagName.toLowerCase()}${cls} ${Math.round(rc.width)}\u00d7${Math.round(rc.height)}`;
      tag.style.top = rc.top < 26 ? (rc.height + 2) + 'px' : '-22px';
    };

    const elementAt = (x, y) => {
      let el = document.elementFromPoint(x, y);
      if (!el) return null;
      if (el === document.documentElement) el = document.body;
      return el;
    };

    const onMove = (e) => {
      if (!e.isTrusted) return;
      ps.x = e.clientX; ps.y = e.clientY;
      ps.stack = [];
      setCandidate(elementAt(e.clientX, e.clientY));
    };

    const onScrollPick = () => {
      if (ps.stack.length === 0 && ps.x >= 0) setCandidate(elementAt(ps.x, ps.y));
      else if (ps.candidate) setCandidate(ps.candidate);
    };

    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

    const onClick = (e) => {
      if (!e.isTrusted) return;
      swallow(e);
      const chosen = ps.candidate || elementAt(e.clientX, e.clientY);
      endPick();
      if (!chosen) return;
      const isPage = chosen === document.body || chosen === document.documentElement;
      startRaid({ manual: true, root: isPage ? null : chosen });
    };

    const onKey = (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Escape') { swallow(e); cancelPick(); }
      else if (e.key === 'ArrowUp' && ps.candidate) {
        swallow(e);
        const parent = ps.candidate.parentElement;
        if (parent && parent !== document.documentElement) { ps.stack.push(ps.candidate); setCandidate(parent); }
      } else if (e.key === 'ArrowDown' && ps.stack.length) {
        swallow(e);
        setCandidate(ps.stack.pop());
      }
    };

    const reg = (target, ev, fn, opts) => {
      target.addEventListener(ev, fn, opts);
      ps.handlers.push([target, ev, fn, opts]);
    };
    reg(window, 'mousemove', onMove, { capture: true, passive: true });
    reg(window, 'scroll', onScrollPick, { capture: true, passive: true });
    reg(window, 'click', onClick, { capture: true });
    reg(window, 'keydown', onKey, { capture: true });
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick']) {
      reg(window, ev, (e) => { if (e.isTrusted) swallow(e); }, { capture: true });
    }
    reg(document, 'visibilitychange', () => { if (document.hidden) cancelPick(); }, { capture: true });
  }

  function endPick() {
    const ps = pickState;
    if (!ps) return;
    pickState = null;
    for (const [t, ev, fn, opts] of ps.handlers) t.removeEventListener(ev, fn, opts);
    ps.host.remove();
    document.documentElement.removeAttribute(PICK_ATTR);
    if (mode === 'picking') mode = 'idle';
  }

  function cancelPick() { endPick(); }

  // ------------------------------------------------------------ raid lifecycle
  // A raid begins with a screenshot of the visible page (taken before our overlay exists) so
  // that blown-up and looted elements can be shown breaking apart / being dragged away.
  function startRaid(opts) {
    if (mode === 'raiding' || document.hidden) return;
    if (mode === 'picking') endPick();
    mode = 'raiding';
    const token = ++raidToken;
    syncListeners();
    captureViewport().then((shot) => {
      if (mode !== 'raiding' || token !== raidToken || raid) {
        if (shot && shot.bitmap.close) shot.bitmap.close();
        return;
      }
      beginRaid(opts, shot);
    });
  }

  function nextPaint() {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      setTimeout(fin, 250);
      requestAnimationFrame(() => requestAnimationFrame(fin));
    });
  }

  // Resolves to { bitmap, sx, sy, scrollX, scrollY } or null (placeholders are used instead).
  async function captureViewport() {
    await nextPaint();
    try {
      const res = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 1800);
        chrome.runtime.sendMessage({ type: 'capture' }, (r) => {
          clearTimeout(timer);
          resolve(chrome.runtime.lastError ? null : r);
        });
      });
      if (!res || !res.dataUrl) return null;
      const comma = res.dataUrl.indexOf(',');
      const mime = res.dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
      const bin = atob(res.dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // createImageBitmap avoids any <img>/data: URL restrictions from the page's CSP.
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
      return { bitmap, sx: bitmap.width / window.innerWidth, sy: bitmap.height / window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY };
    } catch (_) {
      return null;
    }
  }

  function beginRaid({ manual, root }, shot) {
    graceUntil = now() + (manual ? 3000 : 800);
    getSprites();
    createOverlay();

    const scoped = !!(root && root !== document.body && root !== document.documentElement);
    const t = now();
    const r = raid = {
      manual, scoped, root: scoped ? root : null,
      restoreOn: manual ? (settings.restoreOn === 'click' ? 'click' : 'move') : 'move',
      time: 0, last: t, raf: 0, nextAct: 0, fightStart: 0,
      ship: { x: -130, y: 0, dir: 1, state: 'arriving', targetX: 0, wander: 0, bob: 0 },
      pirates: [0, 1, 2, 3].map((i) => ({
        slot: i, state: 'ready', t: 0, dur: 1, hold: 0, start: null, end: null,
        x: 0, y: 0, target: null, carry: false,
      })),
      projectiles: [], particles: [], texts: [],
      pool: [], known: new Set(), states: new Map(),
      stats: { blown: 0, looted: 0 },
      lastScan: -10, finished: false, scrollY: window.scrollY, observer: null, cx: W / 2,
      shot, shards: [],
    };

    const b = raidBounds(r);
    r.ship.targetX = clamp(b.l + (b.r - b.l - SHIP_W * SHIP_PX) * 0.3, 10, Math.max(10, W - SHIP_W * SHIP_PX - 10));
    r.cx = (b.l + b.r) / 2;

    // If a framework strips our attribute mid-raid, put it back.
    r.observer = new MutationObserver((recs) => {
      for (const m of recs) {
        const el = m.target, exp = r.states.get(el);
        if (exp && el.getAttribute(STATE_ATTR) !== exp) el.setAttribute(STATE_ATTR, exp);
      }
    });
    r.observer.observe(document.documentElement, { attributes: true, attributeFilter: [STATE_ATTR], subtree: true });

    syncListeners();
    scan(r);
    r.raf = requestAnimationFrame(frame);
  }

  function endRaid(immediate) {
    if (mode !== 'raiding') return;
    if (!raid) { raidToken++; mode = 'idle'; syncListeners(); return; } // cancelled before it began
    const r = raid;
    raid = null;
    mode = 'idle';
    cancelAnimationFrame(r.raf);
    if (r.observer) r.observer.disconnect();
    if (r.shot && r.shot.bitmap && r.shot.bitmap.close) r.shot.bitmap.close();
    restoreAll(r.states);
    teardownOverlay(immediate);
    lastActivity = now();
    syncListeners();
  }

  function setState(r, el, state) {
    r.states.set(el, state);
    el.setAttribute(STATE_ATTR, state);
  }

  function restoreAll(states) {
    const els = [...states.keys()];
    for (const el of els) el.setAttribute(STATE_ATTR, 'restoring');
    setTimeout(() => {
      for (const el of els) if (el.getAttribute(STATE_ATTR) === 'restoring') el.removeAttribute(STATE_ATTR);
    }, 450);
    states.clear();
  }

  // Where the ship may roam and where it hovers.
  function raidBounds(r) {
    if (!r.scoped) return { l: 0, r: W, y: Math.min(70, H * 0.1) };
    const rc = r.root.getBoundingClientRect();
    return {
      l: clamp(rc.left - 40, 0, W),
      r: clamp(rc.right + 40, 0, W),
      y: clamp(rc.top - 110, 8, Math.max(8, H - 130)),
    };
  }

  // ----------------------------------------------------------------- targeting
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'HEAD', 'TEMPLATE', 'BR', 'HR', 'PIXEL-PIRATES-OVERLAY', 'PIXEL-PIRATES-PICK']);
  const ATOMIC_TAGS = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OBJECT', 'EMBED', 'PROGRESS', 'METER']);

  function hasDirectText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }

  const hasContent = (el) => hasDirectText(el) || (el.textContent || '').trim().length > 0;

  function visibleStyle(el) {
    const cs = getComputedStyle(el);
    return cs.visibility === 'visible' && cs.display !== 'none' && parseFloat(cs.opacity) >= 0.05;
  }

  // Returns the number of NEW targets added.
  function scan(r) {
    r.lastScan = r.time;
    let visited = 0, added = 0;

    const add = (el, rect) => {
      if (!visibleStyle(el)) return;
      const area = rect.width * rect.height;
      let hits = area > 150000 ? 3 : area > 50000 ? 2 : 1;
      if (r.scoped && el === r.root) hits = Math.max(hits, 2); // a picked element deserves a proper beating
      const x0 = Math.max(0, rect.left), y0 = Math.max(0, rect.top);
      const x1 = Math.min(W, rect.right), y1 = Math.min(H, rect.bottom);
      const shotRect = (r.shot && window.scrollX === r.shot.scrollX && window.scrollY === r.shot.scrollY)
        ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
      r.known.add(el);
      r.pool.push({ el, area, hits, hitsLeft: hits, pending: 0, shotRect, sprite: null });
      added++;
    };

    const walk = (el) => {
      if (visited++ > 6000 || el.nodeType !== 1) return;
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || r.known.has(el) || el === host) return;

      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        for (const c of el.children) walk(c);
        return;
      }
      if (rect.bottom <= 0 || rect.top >= H || rect.right <= 0 || rect.left >= W) return;

      const tag = el.tagName.toUpperCase();
      if (ATOMIC_TAGS.has(tag)) {
        if (rect.width >= 8 && rect.height >= 8) add(el, rect);
        return;
      }

      const small = rect.width <= 600 && rect.height <= 260;
      if (small && rect.width >= 8 && rect.height >= 8 && hasContent(el)) { add(el, rect); return; }
      if (hasDirectText(el) && rect.width <= 1000 && rect.height <= 600) { add(el, rect); return; }

      if (el.children.length === 0) {
        if (rect.width >= 8 && rect.height >= 8 && hasContent(el)) add(el, rect);
        return;
      }
      for (const c of el.children) walk(c);
    };

    if (r.scoped) walk(r.root);
    else if (document.body) for (const c of document.body.children) walk(c);
    return added;
  }

  const availableTargets = (r) => r.pool.filter((t) => t.hitsLeft - t.pending > 0);

  function center(el) {
    const rc = el.getBoundingClientRect();
    return { x: clamp(rc.left + rc.width / 2, 10, W - 10), y: clamp(rc.top + rc.height / 2, 10, H - 10) };
  }

  // ------------------------------------------------------------------- actions
  function shipPoint(r, lx, ly) {
    const s = r.ship;
    return { x: s.x + (s.dir > 0 ? lx : SHIP_W - lx) * SHIP_PX, y: s.y + s.bob + ly * SHIP_PX };
  }

  const deckPoint = (r, slot) => shipPoint(r, 8 + slot * 4.5, 17);

  function interval(r) {
    const mult = [1.7, 1.3, 1, 0.7, 0.45][clamp(Math.round(Number(settings.speed)) || 3, 1, 5) - 1];
    const p = clamp((r.time - r.fightStart) / 30, 0, 1); // crew gets more frantic over 30s
    return lerp(0.7, 0.14, p) * mult * rand(0.8, 1.2);
  }

  function act(r) {
    const avail = availableTargets(r);
    if (!avail.length) return;
    const free = r.pirates.find((p) => p.state === 'ready');
    const lootable = free ? avail.filter((t) => t.hitsLeft === 1 && t.pending === 0 && t.area <= 40000) : [];
    if (free && lootable.length && Math.random() < 0.5) sendPirate(r, free, pick(lootable));
    else fireCannon(r, pick(avail));
  }

  function sendPirate(r, p, t) {
    t.pending++;
    p.target = t;
    p.state = 'out';
    p.t = 0;
    p.start = deckPoint(r, p.slot);
    const c = center(t.el);
    p.end = { x: c.x, y: c.y + PIRATE_H * PIRATE_PX * 0.5 };
    p.dur = clamp(dist(p.start, p.end) / 650, 0.45, 1.3);
    p.x = p.start.x; p.y = p.start.y;
  }

  function fireCannon(r, t) {
    t.pending++;
    const port = pick([9, 15, 21]);
    const from = shipPoint(r, port, 20.5);
    const c = center(t.el);
    const d = Math.hypot(c.x - from.x, c.y - from.y);
    r.projectiles.push({ x0: from.x, y0: from.y, x1: c.x, y1: c.y, t: 0, dur: clamp(d / 800, 0.35, 1.1), arc: Math.min(120, d * 0.25), target: t, smoke: 0, x: from.x, y: from.y });
    for (let i = 0; i < 6; i++) spawn(r, from.x, from.y, rand(-40, 40), rand(-60, -10), rand(0.4, 0.8), 6, '#9a9a9a', -10);
  }

  function hit(r, t, kind, impact) {
    t.hitsLeft--;
    const at = impact || center(t.el);
    if (t.hitsLeft <= 0) {
      if (kind === 'cannon') shatter(r, t, at); // build shards from the pixels BEFORE hiding the element
      setState(r, t.el, 'gone');
      r.pool = r.pool.filter((x) => x !== t);
      if (kind === 'loot') r.stats.looted++; else r.stats.blown++;
    } else {
      if (kind === 'cannon') chip(r, t, at);
      setState(r, t.el, 'scorched');
    }
  }

  function spawn(r, x, y, vx, vy, life, size, color, g) {
    if (r.particles.length > MAX_PARTICLES) return;
    r.particles.push({ x, y, vx, vy, life, max: life, size, color, g });
  }

  function explode(r, t) {
    const rc = t.el.getBoundingClientRect();
    const bursts = t.hitsLeft <= 0 ? clamp(Math.round(t.area / 40000) + 1, 1, 4) : 1;
    const cols = ['#f39c12', '#e74c3c', '#f1c40f', '#4a4a4a', '#fff3b0'];
    for (let b = 0; b < bursts; b++) {
      const x = clamp(rc.left + rand(0.2, 0.8) * rc.width, 0, W);
      const y = clamp(rc.top + rand(0.2, 0.8) * rc.height, 0, H);
      for (let i = 0; i < 14; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(80, 260);
        spawn(r, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.35, 0.8), pick([3, 3, 6]), pick(cols), 300);
      }
      for (let i = 0; i < 6; i++) spawn(r, x + rand(-10, 10), y + rand(-10, 10), rand(-20, 20), rand(-70, -30), rand(0.8, 1.3), 6, '#6b6b6b', -20);
    }
  }

  function coins(r, x, y) {
    for (let i = 0; i < 8; i++) spawn(r, x, y, rand(-70, 70), rand(-140, -40), rand(0.4, 0.8), 3, pick(['#f1c40f', '#f9e79f', '#d4a017']), 350);
  }

  // ------------------------------------------------- element sprites + shattering
  // Cut an element's pixels out of the raid-start screenshot. Falls back to a painted stand-in.
  function getTargetSprite(r, t) {
    if (t.sprite) return t.sprite;
    const rc = t.el.getBoundingClientRect();
    const x0 = Math.max(0, rc.left), y0 = Math.max(0, rc.top);
    const x1 = Math.min(W, rc.right), y1 = Math.min(H, rc.bottom);
    const w = Math.max(4, x1 - x0), h = Math.max(4, y1 - y0);
    const sr = t.shotRect;
    let canvas = null, sw = w, sh = h, fromShot = false;

    if (r.shot && sr && sr.w >= 2 && sr.h >= 2) {
      const { bitmap, sx, sy } = r.shot;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sr.w * sx));
      c.height = Math.max(1, Math.round(sr.h * sy));
      try {
        c.getContext('2d').drawImage(bitmap, sr.x * sx, sr.y * sy, sr.w * sx, sr.h * sy, 0, 0, c.width, c.height);
        canvas = c; sw = sr.w; sh = sr.h; fromShot = true;
      } catch (_) { canvas = null; }
    }
    if (!canvas) canvas = placeholderSprite(t.el, Math.round(w), Math.round(h));

    // Draw where the element sits now (matches the screenshot unless the page scrolled).
    const aligned = fromShot && Math.abs(sw - w) <= 2 && Math.abs(sh - h) <= 2;
    const ox = aligned ? x0 : rc.left + rc.width / 2 - sw / 2;
    const oy = aligned ? y0 : rc.top + rc.height / 2 - sh / 2;
    t.sprite = { canvas, w: sw, h: sh, x: ox, y: oy };
    return t.sprite;
  }

  function backgroundOf(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    }
    return '#f4f4f4';
  }

  function placeholderSprite(el, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    const g = c.getContext('2d');
    const tag = el.tagName.toUpperCase();
    if (tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IFRAME') {
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#7f8fa6'); grad.addColorStop(1, '#4b6584');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.beginPath(); g.moveTo(0, h); g.lineTo(w * 0.35, h * 0.45); g.lineTo(w * 0.6, h * 0.8); g.lineTo(w * 0.8, h * 0.55); g.lineTo(w, h); g.closePath(); g.fill();
    } else {
      g.fillStyle = backgroundOf(el); g.fillRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(el).color || '#222';
      g.globalAlpha = 0.55;
      for (let y = 8; y < h - 8; y += 12) g.fillRect(8, y, (w - 16) * rand(0.45, 1), 5);
      g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1; g.strokeRect(0.5, 0.5, w - 1, h - 1);
    return c;
  }

  // Break an element into jittered triangular shards that fly away from the impact point.
  function shatter(r, t, impact) {
    if (r.shards.length > MAX_SHARDS) return;
    const sp = getTargetSprite(r, t);
    const { w, h } = sp;
    const cell = clamp(Math.sqrt((w * h) / 12), 28, 110);
    const cols = Math.max(2, Math.ceil(w / cell)), rows = Math.max(2, Math.ceil(h / cell));
    const kx = sp.canvas.width / w, ky = sp.canvas.height / h;
    const scorched = t.hits > 1; // it was already charred, so its shards are too

    const grid = [];
    for (let j = 0; j <= rows; j++) {
      grid.push([]);
      for (let i = 0; i <= cols; i++) {
        let px = (i * w) / cols, py = (j * h) / rows;
        if (i > 0 && i < cols && j > 0 && j < rows) { px += rand(-0.25, 0.25) * (w / cols); py += rand(-0.25, 0.25) * (h / rows); }
        grid[j].push({ x: px, y: py });
      }
    }

    const addShard = (tri) => {
      const xs = tri.map((q) => q.x), ys = tri.map((q) => q.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(bw * kx)); c.height = Math.max(1, Math.ceil(bh * ky));
      const g = c.getContext('2d');
      g.scale(kx, ky); g.translate(-minX, -minY);
      g.beginPath(); g.moveTo(tri[0].x, tri[0].y); g.lineTo(tri[1].x, tri[1].y); g.lineTo(tri[2].x, tri[2].y); g.closePath();
      g.save();
      g.clip();
      g.drawImage(sp.canvas, 0, 0, w, h);
      if (scorched) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(25,12,0,.45)'; g.fillRect(0, 0, w, h); }
      g.restore();
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.stroke(); // crack lines

      const cx = (xs[0] + xs[1] + xs[2]) / 3, cy = (ys[0] + ys[1] + ys[2]) / 3;
      const wx = sp.x + cx, wy = sp.y + cy;
      const dx = wx - impact.x, dy = wy - impact.y, d = Math.hypot(dx, dy) || 1;
      const speed = rand(140, 380);
      const life = rand(1.0, 1.7);
      r.shards.push({
        c, bw, bh, ox: cx - minX, oy: cy - minY, x: wx, y: wy,
        vx: (dx / d) * speed + rand(-40, 40), vy: (dy / d) * speed - rand(60, 260),
        rot: 0, vr: rand(-7, 7), life, max: life, g: 1100,
      });
    };

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i], d = grid[j + 1][i + 1];
        if (Math.random() < 0.5) { addShard([a, b, d]); addShard([a, d, c]); }
        else { addShard([a, b, c]); addShard([b, d, c]); }
      }
    }
  }

  // A glancing hit knocks a few chunks off but leaves the element standing (charred).
  function chip(r, t, impact) {
    if (r.shards.length > MAX_SHARDS) return;
    const sp = getTargetSprite(r, t);
    const kx = sp.canvas.width / sp.w, ky = sp.canvas.height / sp.h;
    for (let n = 0; n < 3; n++) {
      const cw = clamp(sp.w * rand(0.12, 0.25), 8, 48), ch = clamp(sp.h * rand(0.12, 0.25), 8, 48);
      const px = rand(0, Math.max(0, sp.w - cw)), py = rand(0, Math.max(0, sp.h - ch));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(cw * kx)); c.height = Math.max(1, Math.ceil(ch * ky));
      const g = c.getContext('2d');
      g.drawImage(sp.canvas, px * kx, py * ky, cw * kx, ch * ky, 0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(25,12,0,.45)'; g.fillRect(0, 0, c.width, c.height);
      const wx = sp.x + px + cw / 2, wy = sp.y + py + ch / 2;
      const dx = wx - impact.x, dy = wy - impact.y, d = Math.hypot(dx, dy) || 1;
      const life = rand(0.7, 1.2);
      r.shards.push({
        c, bw: cw, bh: ch, ox: cw / 2, oy: ch / 2, x: wx, y: wy,
        vx: (dx / d) * rand(100, 240), vy: (dy / d) * 100 - rand(80, 200),
        rot: 0, vr: rand(-8, 8), life, max: life, g: 1100,
      });
    }
  }

  function lootHit(r, p) {
    const t = p.target;
    t.pending--;
    const sp = getTargetSprite(r, t);
    p.loot = {
      sp, x: sp.x + sp.w / 2, y: sp.y + sp.h / 2, rot: 0, scale: 1,
      fit: clamp(44 / Math.max(sp.w, sp.h), 0.18, 1), // size it shrinks to while being hauled up
    };
    hit(r, t, 'loot');
    coins(r, p.x, p.y - 12);
  }

  // ------------------------------------------------------------------- update
  function frame(ts) {
    if (!raid) return;
    const r = raid;
    if (!alive()) { endRaid(true); return; } // extension was reloaded/removed: restore and bail
    const dt = Math.min(0.05, Math.max(0, (ts - r.last) / 1000));
    r.last = ts;
    update(r, dt);
    draw(r);
    if (raid === r) r.raf = requestAnimationFrame(frame);
  }

  function update(r, dt) {
    r.time += dt;
    const s = r.ship;
    const b = raidBounds(r);
    r.cx = (b.l + b.r) / 2;
    s.bob = Math.sin(r.time * 2.2) * 3;
    s.y = b.y;

    // ship movement
    const dx = s.targetX - s.x;
    if (Math.abs(dx) > 3) {
      const sp = clamp(Math.abs(dx) * 1.1, 35, 260);
      s.x += Math.sign(dx) * Math.min(Math.abs(dx), sp * dt);
      if (Math.abs(dx) > 25) s.dir = Math.sign(dx);
    }
    if (s.state === 'arriving' && Math.abs(dx) <= 6) {
      s.state = 'fighting';
      r.fightStart = r.time;
      r.nextAct = r.time + 0.4;
      s.wander = r.time + 2.5;
    }

    if (s.state === 'fighting' && !r.finished) {
      if (r.time >= s.wander) {
        const maxX = Math.max(b.l, b.r - SHIP_W * SHIP_PX);
        s.targetX = clamp(rand(b.l, maxX), 10, Math.max(10, W - SHIP_W * SHIP_PX - 10));
        s.wander = r.time + rand(2, 4);
      }
      let guard = 0;
      while (r.time >= r.nextAct && guard++ < 3) { act(r); r.nextAct += interval(r); }
      if (r.nextAct < r.time) r.nextAct = r.time;
      checkDone(r);
    }

    // pirates
    for (const p of r.pirates) {
      if (p.state === 'ready') continue;
      const deck = deckPoint(r, p.slot);
      if (p.state === 'out') {
        p.t += dt / p.dur;
        const k = Math.min(1, p.t), e = ease(k);
        p.x = lerp(p.start.x, p.end.x, e);
        p.y = lerp(p.start.y, p.end.y, e) - Math.sin(Math.PI * k) * 50;
        if (p.t >= 1) { p.x = p.end.x; p.y = p.end.y; p.state = 'grab'; p.hold = 0.3; lootHit(r, p); }
      } else if (p.state === 'grab') {
        p.hold -= dt;
        if (p.loot) p.loot.rot = Math.sin(r.time * 45) * 0.04; // loot jerks as the pirate hooks it
        if (p.hold <= 0) {
          p.state = 'back'; p.t = 0;
          p.start = { x: p.x, y: p.y };
          p.dur = clamp(dist(p.start, deck) / 650, 0.45, 1.3);
        }
      } else if (p.state === 'back') {
        p.t += dt / p.dur;
        const k = Math.min(1, p.t), e = ease(k);
        p.x = lerp(p.start.x, deck.x, e);
        p.y = lerp(p.start.y, deck.y, e) - Math.sin(Math.PI * k) * 40;
        if (p.loot) {
          // The element shrinks as it's hauled up, trails behind the pirate on a rope, and is
          // stowed behind the ship's rail at the end.
          const L = p.loot;
          const shrink = ease(clamp(k / 0.4, 0, 1));
          L.scale = lerp(1, L.fit, shrink) * (k > 0.85 ? clamp(1 - (k - 0.85) / 0.15, 0, 1) : 1);
          const tx = p.x, ty = p.y - 10 + (L.sp.h * L.scale) / 2 + 8;
          const f = 1 - Math.exp(-dt * 8);
          L.x += (tx - L.x) * f; L.y += (ty - L.y) * f;
          L.rot = clamp((L.x - tx) * 0.015, -0.7, 0.7);
        }
        if (p.t >= 1) {
          p.state = 'ready'; p.loot = null;
          coins(r, deck.x, deck.y - 20);
          r.texts.push({ x: deck.x, y: deck.y - 30, text: '+1', life: 0.9, max: 0.9, color: '#f1c40f' });
        }
      }
    }

    // cannonballs
    for (let i = r.projectiles.length - 1; i >= 0; i--) {
      const pr = r.projectiles[i];
      pr.t += dt / pr.dur;
      const k = Math.min(1, pr.t);
      pr.x = lerp(pr.x0, pr.x1, k);
      pr.y = lerp(pr.y0, pr.y1, k) - Math.sin(Math.PI * k) * pr.arc;
      pr.smoke -= dt;
      if (pr.smoke <= 0) { pr.smoke = 0.04; spawn(r, pr.x, pr.y, rand(-10, 10), rand(-10, 10), 0.4, 3, '#8a8a8a', 0); }
      if (pr.t >= 1) {
        r.projectiles.splice(i, 1);
        pr.target.pending--;
        hit(r, pr.target, 'cannon', { x: pr.x1, y: pr.y1 });
        explode(r, pr.target);
      }
    }

    // shattered pieces
    for (let i = r.shards.length - 1; i >= 0; i--) {
      const sh = r.shards[i];
      sh.life -= dt;
      if (sh.life <= 0 || sh.y > H + 80) { r.shards[i] = r.shards[r.shards.length - 1]; r.shards.pop(); continue; }
      sh.vy += sh.g * dt; sh.x += sh.vx * dt; sh.y += sh.vy * dt; sh.rot += sh.vr * dt;
      sh.vx *= 1 - 0.6 * dt;
    }

    // particles + floating text
    for (let i = r.particles.length - 1; i >= 0; i--) {
      const q = r.particles[i];
      q.life -= dt;
      if (q.life <= 0) { r.particles[i] = r.particles[r.particles.length - 1]; r.particles.pop(); continue; }
      q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt;
    }
    for (let i = r.texts.length - 1; i >= 0; i--) {
      const t = r.texts[i];
      t.life -= dt; t.y -= 30 * dt;
      if (t.life <= 0) r.texts.splice(i, 1);
    }
  }

  function checkDone(r) {
    const pending = r.projectiles.length > 0 || r.pirates.some((p) => p.state !== 'ready');
    if (pending || availableTargets(r).length) return;
    if (r.time - r.lastScan < 0.35) return;
    if (scan(r) === 0) {
      r.finished = true;
      r.ship.state = 'done';
      r.ship.targetX = clamp(r.cx - (SHIP_W * SHIP_PX) / 2, 10, Math.max(10, W - SHIP_W * SHIP_PX - 10));
    }
  }

  // --------------------------------------------------------------------- draw
  function drawPirate(x, feetY, frameIdx) {
    const spr = frameIdx ? S.pirateB : S.pirateA;
    ctx.drawImage(spr, Math.round(x - (PIRATE_W * PIRATE_PX) / 2), Math.round(feetY - PIRATE_H * PIRATE_PX), PIRATE_W * PIRATE_PX, PIRATE_H * PIRATE_PX);
  }

  function draw(r) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const s = r.ship;

    // ropes under everything
    ctx.strokeStyle = '#c9b27a';
    ctx.lineWidth = 2;
    for (const p of r.pirates) {
      if (p.state === 'ready') continue;
      const d = deckPoint(r, p.slot);
      ctx.beginPath();
      ctx.moveTo(Math.round(d.x), Math.round(d.y - 14));
      ctx.lineTo(Math.round(p.x), Math.round(p.y - 14));
      ctx.stroke();
    }

    // dragged loot: the real element, on a rope behind its pirate
    for (const p of r.pirates) {
      const L = p.loot;
      if (!L || L.scale <= 0.01) continue;
      const lw = L.sp.w * L.scale, lh = L.sp.h * L.scale;
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x), Math.round(p.y - 10));
      ctx.lineTo(Math.round(L.x), Math.round(L.y - lh / 2));
      ctx.stroke();
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.translate(L.x, L.y); ctx.rotate(L.rot);
      ctx.drawImage(L.sp.canvas, -lw / 2, -lh / 2, lw, lh);
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1;
      ctx.strokeRect(-lw / 2, -lh / 2, lw, lh);
      ctx.restore();
    }

    // flying / working pirates
    for (const p of r.pirates) {
      if (p.state === 'ready') continue;
      drawPirate(p.x, p.y, Math.floor(r.time * 8) % 2);
    }

    // ship
    const sw = SHIP_W * SHIP_PX, sh = SHIP_H * SHIP_PX;
    ctx.save();
    ctx.translate(Math.round(s.x + (s.dir < 0 ? sw : 0)), Math.round(s.y + s.bob));
    ctx.scale(s.dir, 1);
    ctx.drawImage(S.ship, 0, 0, sw, sh);
    ctx.restore();

    // pirates standing on deck
    for (const p of r.pirates) {
      if (p.state !== 'ready') continue;
      const d = deckPoint(r, p.slot);
      const hop = Math.sin(r.time * 4 + p.slot * 1.7) > 0.8 ? -2 : 0;
      drawPirate(d.x, d.y + hop, 0);
    }

    // shattered pieces tumbling away
    ctx.imageSmoothingEnabled = true;
    for (const sh of r.shards) {
      ctx.globalAlpha = clamp(sh.life / (sh.max * 0.45), 0, 1);
      ctx.save();
      ctx.translate(sh.x, sh.y); ctx.rotate(sh.rot);
      ctx.drawImage(sh.c, -sh.ox, -sh.oy, sh.bw, sh.bh);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;

    // cannonballs
    for (const b of r.projectiles) {
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(Math.round(b.x), Math.round(b.y), 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6b6b6b';
      ctx.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 3, 3, 3);
    }

    // particles (snapped to a 3px grid for the pixel look)
    for (const q of r.particles) {
      ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
      ctx.fillStyle = q.color;
      ctx.fillRect(Math.round(q.x / 3) * 3, Math.round(q.y / 3) * 3, q.size, q.size);
    }
    ctx.globalAlpha = 1;

    // floating text
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.textAlign = 'center';
    for (const t of r.texts) {
      ctx.globalAlpha = clamp(t.life / t.max, 0, 1);
      ctx.fillStyle = '#000'; ctx.fillText(t.text, t.x + 1, t.y + 1);
      ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;

    if (r.finished && r.ship.state === 'done') drawBanner(r);
  }

  function drawBanner(r) {
    const empty = r.stats.blown + r.stats.looted === 0;
    const stop = r.restoreOn === 'click' ? 'Click or press a key to restore' : 'Move your mouse to restore';
    const lines = empty
      ? ['NOTHING WORTH PLUNDERING', 'Slim pickings, captain.', stop]
      : ['PLUNDER COMPLETE', `${r.stats.blown} blown up  |  ${r.stats.looted} looted`, stop];
    const bw = Math.min(W - 20, 460), bh = 96;
    const cx = clamp(r.cx, bw / 2 + 10, Math.max(bw / 2 + 10, W - bw / 2 - 10));
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(clamp(r.ship.y + SHIP_H * SHIP_PX + 30, 8, Math.max(8, H - bh - 10)));
    ctx.fillStyle = '#0f2540'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#d4a017'; ctx.lineWidth = 3; ctx.strokeRect(bx + 1.5, by + 1.5, bw - 3, bh - 3);
    ctx.textAlign = 'center';
    ctx.font = 'bold 22px "Courier New", monospace'; ctx.fillStyle = '#f1c40f';
    ctx.fillText(lines[0], cx, by + 34);
    ctx.font = 'bold 16px "Courier New", monospace'; ctx.fillStyle = '#f2efe6';
    ctx.fillText(lines[1], cx, by + 59);
    ctx.font = '13px "Courier New", monospace'; ctx.fillStyle = '#9db4cc';
    ctx.fillText(lines[2], cx, by + 81);
  }
})();
