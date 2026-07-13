/**
 * Background service worker — extension entry point.
 *
 * Responsibilities:
 *  - Create and manage the Player instance.
 *  - Register context menus and handle keyboard commands.
 *  - Handle messages from popup, content script, and offscreen document.
 *  - Push state updates to any open popup.
 *  - Recover in-progress playback after service-worker restart.
 */

import { Player }          from './player';
import type { PlayTrigger } from './player';
import { loadSettings, saveSettings } from '../lib/storage';
import type {
  BackgroundMessage,
  OffscreenToBackground,
  StateUpdateMessage,
  PlayerStatePayload,
} from '../lib/messages';

// ---------------------------------------------------------------------------
// Context menu IDs
// ---------------------------------------------------------------------------

const CTX_READ_SELECTION = 'read-selection';
const CTX_READ_PAGE      = 'read-page';
const CTX_READ_FROM_HERE = 'read-from-here';
const CTX_STOP           = 'stop-reading';
const POPUP_PORT_NAME    = 'read-aloud-popup';

// ---------------------------------------------------------------------------
// Player singleton
// ---------------------------------------------------------------------------

const player = new Player(onStateChange);
let popupTabId: number | null = null;
let lastKnownTabId: number | null = null;
let extensionEnabled = false;

// Load enabled state on startup
loadSettings().then(s => {
  extensionEnabled = s.enabled;
  updateBadge();
}).catch(() => undefined);

// ---------------------------------------------------------------------------
// State broadcast
// ---------------------------------------------------------------------------

function onStateChange(state: PlayerStatePayload): void {
  const msg: StateUpdateMessage = { type: 'STATE_UPDATE', state };

  // Send to popup (extension pages)
  chrome.runtime.sendMessage(msg).catch(() => undefined);

  // Send to content script in the active tab
  const tabId = player.activeTabId ?? lastKnownTabId;
  if (tabId) {
    lastKnownTabId = tabId;
    chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
  }
}

function sendPopupVisibility(tabId: number | null, open: boolean): void {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'POPUP_VISIBILITY',
    open,
  }).catch(() => undefined);
}

function sendEnabledToTab(tabId: number, enabled: boolean): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'SET_ENABLED',
    enabled,
  }).catch(() => undefined);
}

function updateBadge(): void {
  chrome.action.setBadgeText({ text: extensionEnabled ? '' : 'OFF' }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ color: '#666' }).catch(() => undefined);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== POPUP_PORT_NAME) return;

  port.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string; tabId?: number };
    if (msg.type !== 'POPUP_OPENED') return;
    popupTabId = msg.tabId ?? null;
    if (popupTabId) lastKnownTabId = popupTabId;
    if (extensionEnabled && popupTabId) {
      sendPopupVisibility(popupTabId, true);
    }
  });

  port.onDisconnect.addListener(() => {
    const targets = new Set<number>();
    if (popupTabId) targets.add(popupTabId);
    if (player.activeTabId) targets.add(player.activeTabId);
    if (lastKnownTabId) targets.add(lastKnownTabId);

    // Tell all relevant tabs that the popup closed
    for (const tabId of targets) {
      sendPopupVisibility(tabId, false);
    }

    popupTabId = null;
  });
});

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // Context menus must be re-registered after install/update.
  // Voice loading and session restore are handled by the IIFE below.
  registerContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
});

/**
 * Runs once every time the service worker is evaluated (initial load AND
 * every wake-up from idle).  This is the single place we load voices and
 * attempt session recovery so we don't duplicate work on install/startup.
 */
(async () => {
  await player.loadVoices().catch(console.error);
  await player.tryRestoreSession().catch(console.error);
})();

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       CTX_READ_SELECTION,
      title:    'Read selection aloud',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id:       CTX_READ_FROM_HERE,
      title:    'Start reading here',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id:       CTX_READ_PAGE,
      title:    'Read this page aloud',
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id:       CTX_STOP,
      title:    'Stop reading aloud',
      contexts: ['page', 'selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (!tabId) return;

  switch (info.menuItemId) {
    case CTX_READ_SELECTION:
      player.play(tabId, 'selection').catch(console.error);
      break;
    case CTX_READ_FROM_HERE:
      player.play(tabId, 'from-here').catch(console.error);
      break;
    case CTX_READ_PAGE:
      player.play(tabId, 'page').catch(console.error);
      break;
    case CTX_STOP:
      player.stop().catch(console.error);
      break;
  }
});

// ---------------------------------------------------------------------------
// Keyboard commands
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async command => {
  // lastFocusedWindow targets the browser window, not the popup window
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = tab?.id;
  if (!tabId) return;

  switch (command) {
    case 'read-selection':
      player.play(tabId, 'selection').catch(console.error);
      break;
    case 'read-page':
      player.play(tabId, 'page').catch(console.error);
      break;
    case 'stop-reading':
      player.stop().catch(console.error);
      break;
  }
});

// ---------------------------------------------------------------------------
// Tab events — stop reading if the user reloads or navigates away
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;

  const currentState = player.getState();
  if (player.activeTabId === tabId && currentState.status !== 'idle') {
    player.stop().catch(console.error);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (player.activeTabId === tabId) {
    player.stop().catch(console.error);
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (rawMessage: unknown, sender, sendResponse) => {
    const msg = rawMessage as BackgroundMessage | OffscreenToBackground;

    // ── Messages from offscreen document ──────────────────────────────────
    // ── Messages from popup ───────────────────────────────────────────────
    if (msg.type === 'CHUNK_DONE') {
      player.onChunkDone(
        msg.ok,
        msg.error,
        msg.engine ?? 'speech-synthesis',
      ).catch(console.error);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'WORD_BOUNDARY') {
      player.onWordBoundary(
        msg.charIndex,
        msg.charLength,
        msg.engine ?? 'speech-synthesis',
      );
      return false;
    }

    if (msg.type === 'WORD_BOUNDARY_SCHEDULE') {
      player.onWordBoundarySchedule(
        msg.words,
        msg.durationMs,
        msg.engine,
      );
      return false;
    }

    if (msg.type === 'ENGINE_STATUS') {
      player.onEngineStatus(msg.engine, msg.status);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GET_STATE') {
      sendResponse({ ok: true, state: player.getState() });
      return false;
    }

    if (msg.type === 'PLAYBACK_COMMAND') {
      // Block playback when extension is disabled
      if (!extensionEnabled && (msg.command === 'PLAY' || msg.command === 'RESUME')) {
        sendResponse({ ok: false, error: 'Extension is disabled. Enable it first.' });
        return false;
      }
      handlePlaybackCommand(msg.command, sendResponse, msg, sender).catch(console.error);
      return true; // keep channel open — sendResponse is called asynchronously
    }

    if (msg.type === 'SET_RATE') {
      player.applyRate(msg.rate);
      sendResponse({ ok: true, state: player.getState() });
      return false;
    }

    if (msg.type === 'SET_VOICE') {
      player.applyVoice(msg.voiceId)
        .then(() => sendResponse({ ok: true, state: player.getState() }))
        .catch((err: unknown) => sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      return true;
    }

    if ((msg as unknown as Record<string, unknown>).type === 'SET_ENABLED') {
      const raw = msg as unknown as Record<string, unknown>;
      const enabled = raw.enabled as boolean;
      extensionEnabled = enabled;
      saveSettings({ enabled }).catch(() => undefined);
      updateBadge();

      // Broadcast to the active tab so the content script updates immediately
      const tabId = raw.tabId as number | undefined;
      const target = tabId ?? lastKnownTabId;
      if (target) {
        sendEnabledToTab(target, enabled);
      }

      // If disabling, also stop playback
      if (!enabled) {
        player.stop().catch(console.error);
      }

      sendResponse({ ok: true, state: player.getState() });
      return false;
    }

    if ((msg as unknown as Record<string, unknown>).type === 'GET_ENABLED') {
      sendResponse({ ok: true, enabled: extensionEnabled });
      return false;
    }

    // Unknown message — do not keep channel open
    return false;
  },
);

async function handlePlaybackCommand(
  command: string,
  sendResponse: (r: unknown) => void,
  msg?: { trigger?: string; pasteText?: string; tabId?: number },
  sender?: chrome.runtime.MessageSender,
): Promise<void> {
  try {
    switch (command) {
      case 'PLAY': {
        let tabId = msg?.tabId ?? sender?.tab?.id ?? null;
        if (!tabId) {
          // lastFocusedWindow: the popup is its own window; currentWindow would
          // resolve to the popup window which has no tabs.
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tabId = tab?.id ?? null;
        }
        if (!tabId) throw new Error('Open a webpage, then try again.');
        const trigger    = (msg?.trigger ?? 'page') as PlayTrigger;
        const pasteText  = msg?.pasteText ?? '';
        await player.play(tabId, trigger, pasteText);
        break;
      }
      case 'PAUSE':
        player.pause();
        break;
      case 'RESUME':
        player.resume();
        break;
      case 'STOP':
        await player.stop();
        break;
    }
    sendResponse({ ok: true, state: player.getState() });
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
