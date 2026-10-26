const DEFAULTS = { speed: 3, restoreOn: 'move', idleEnabled: false, idleSeconds: 45, respectReducedMotion: true, disabledHosts: [] };
const ORIGINS = ['http://*/*', 'https://*/*'];
const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t; if (t) setTimeout(() => { if ($('msg').textContent === t) $('msg').textContent = ''; }, 4000); };

function syncIdleFieldset() { $('idleOpts').disabled = !$('idleEnabled').checked; }

(async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const hasPerm = await chrome.permissions.contains({ origins: ORIGINS });

  $('restoreOn').value = s.restoreOn;
  $('speed').value = s.speed;
  $('idleEnabled').checked = !!(s.idleEnabled && hasPerm);
  $('idleSeconds').value = s.idleSeconds;
  $('reduced').checked = s.respectReducedMotion;
  $('hosts').value = (s.disabledHosts || []).join('\n');
  syncIdleFieldset();

  $('restoreOn').onchange = () => chrome.storage.sync.set({ restoreOn: $('restoreOn').value });
  $('speed').oninput = () => chrome.storage.sync.set({ speed: Number($('speed').value) });
  $('reduced').onchange = () => chrome.storage.sync.set({ respectReducedMotion: $('reduced').checked });
  $('idleSeconds').onchange = () => {
    const v = Math.min(3600, Math.max(5, Math.round(Number($('idleSeconds').value) || 45)));
    $('idleSeconds').value = v;
    chrome.storage.sync.set({ idleSeconds: v });
  };
  $('hosts').onchange = () => {
    const list = $('hosts').value.split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean);
    chrome.storage.sync.set({ disabledHosts: list });
  };

  $('idleEnabled').onchange = () => {
    if ($('idleEnabled').checked) {
      // permissions.request must be called directly from the user gesture
      chrome.permissions.request({ origins: ORIGINS }).then(async (granted) => {
        if (!granted) { $('idleEnabled').checked = false; syncIdleFieldset(); say('No permission, no surprise raids.'); return; }
        await chrome.storage.sync.set({ idleEnabled: true });
        syncIdleFieldset();
        say('Surprise mode on. The crew is watching for idle tabs.');
      });
    } else {
      chrome.storage.sync.set({ idleEnabled: false }).then(async () => {
        await chrome.permissions.remove({ origins: ORIGINS }).catch(() => {});
        syncIdleFieldset();
        say('Surprise mode off. Pirates only come when called.');
      });
    }
  };

  $('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
})();
