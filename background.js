// Pixel Pirates - service worker.
// Nothing runs on a page until the user invokes it (toolbar click, hotkey, context menu).
// The content script is injected on demand using activeTab, so the install warning is minimal.
// Optional idle mode registers the same content script on all sites, but only after the user
// opts in on the options page and grants the optional host permission.

const ORIGINS = ['http://*/*', 'https://*/*'];
const IDLE_SCRIPT_ID = 'pp-idle';

// ---------------------------------------------------------------- invoking
async function invoke(tabId, type) {
  try {
    // Already injected? Just talk to it.
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type });
      if (res && res.ok) return;
    } catch (_) { /* not injected yet */ }

    await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type });
  } catch (_) {
    flagError(tabId);
  }
}

function flagError(tabId) {
  // chrome:// pages, the Web Store, the PDF viewer, etc. can't be scripted.
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' });
  chrome.action.setBadgeText({ tabId, text: 'X' });
  chrome.action.setTitle({ tabId, title: 'The pirates can\u2019t board this page' });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: 'Send in the pirates (click again to stop)' }).catch(() => {});
  }, 2500);
}

chrome.action.onClicked.addListener((tab) => { if (tab.id != null) invoke(tab.id, 'invoke'); });

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  if (command === 'raid-now') invoke(tab.id, 'invoke');
  if (command === 'pick-target') invoke(tab.id, 'pick');
});

// ------------------------------------------------------------ context menus
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'pp-raid-page', title: 'Send the pirates to plunder this page', contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'pp-pick', title: 'Pick something to plunder\u2026', contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'pp-options', title: 'Pirate settings', contexts: ['action'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'pp-options') { chrome.runtime.openOptionsPage(); return; }
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'pp-raid-page') invoke(tab.id, 'raid-page');
  if (info.menuItemId === 'pp-pick') invoke(tab.id, 'pick');
});

// -------------------------------------------------- optional idle-mode wiring
async function syncIdle() {
  const { idleEnabled } = await chrome.storage.sync.get({ idleEnabled: false });
  const hasPerm = await chrome.permissions.contains({ origins: ORIGINS });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [IDLE_SCRIPT_ID] });

  if (idleEnabled && hasPerm) {
    if (!existing.length) {
      await chrome.scripting.registerContentScripts([{
        id: IDLE_SCRIPT_ID,
        matches: ORIGINS,
        js: ['content.js'],
        css: ['styles.css'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      }]);
      injectIntoOpenTabs();
    }
  } else if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [IDLE_SCRIPT_ID] });
  }
}

// Newly opted-in users shouldn't have to reload every tab.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ORIGINS });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) { /* tab not scriptable */ }
  }
}

chrome.runtime.onInstalled.addListener(() => { createMenus(); syncIdle().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { syncIdle().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { syncIdle().catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { syncIdle().catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'idleEnabled' in changes) syncIdle().catch(() => {});
});
