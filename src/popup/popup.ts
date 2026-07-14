import { loadSettings, saveSettings }      from '../lib/storage';
import type { ReadAloudSettings }           from '../lib/storage';
import type {
  BackgroundMessage,
  BackgroundResponse,
  PlayerStatePayload,
  PlayerStatus,
} from '../lib/messages';
import type { ExtractionSource }            from '../lib/text/types';

const BROWSER_MAX_RATE = 4;
const KOKORO_MAX_RATE = 2;

// ---------------------------------------------------------------------------
// DOM refs — typed helpers to avoid repetitive casts
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found in popup DOM`);
  return el as T;
}

const btnPlay        = $<HTMLButtonElement>('btn-play');
const btnPause       = $<HTMLButtonElement>('btn-pause');
const btnResume      = $<HTMLButtonElement>('btn-resume');
const btnStop        = $<HTMLButtonElement>('btn-stop');
const statusBadge    = $<HTMLSpanElement>('status-badge');
const progressFill   = $<HTMLDivElement>('progress-fill');
const progressBar    = $<HTMLDivElement>('progress-bar');
const progressLabel  = $<HTMLSpanElement>('progress-label');
const voiceSelect    = $<HTMLSelectElement>('voice-select');
const kokoroSpeedNote = $<HTMLParagraphElement>('kokoro-speed-note');
const rangeRate      = $<HTMLInputElement>('range-rate');
const rangePitch     = $<HTMLInputElement>('range-pitch');
const rangeVolume    = $<HTMLInputElement>('range-volume');
const valRate        = $<HTMLSpanElement>('val-rate');
const valPitch       = $<HTMLSpanElement>('val-pitch');
const valVolume      = $<HTMLSpanElement>('val-volume');
const chkScroll      = $<HTMLInputElement>('chk-scroll');
const chkEnabled     = $<HTMLInputElement>('chk-enabled');
const pasteArea      = $<HTMLTextAreaElement>('paste-text');
const errorBanner    = $<HTMLDivElement>('error-banner');
const segBtns        = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg-btn'));

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

let settings: ReadAloudSettings;
let playerState: PlayerStatePayload = {
  status:       'idle',
  chunkIndex:   0,
  totalChunks:  0,
  errorMessage: null,
  voices:       [],
};
const popupPort = chrome.runtime.connect({ name: 'read-aloud-popup' });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  settings = await loadSettings();

  // Set the enable/disable toggle from saved state
  chkEnabled.checked = settings.enabled;
  applyEnabledUI(settings.enabled);

  const activeTabId = await getActiveTabId();
  if (activeTabId) {
    await chrome.scripting
      .executeScript({ target: { tabId: activeTabId }, files: ['dist/content/content.js'] })
      .catch(() => undefined);
    popupPort.postMessage({ type: 'POPUP_OPENED', tabId: activeTabId });

    // Tell content script the current enabled state
    if (settings.enabled) {
      chrome.tabs.sendMessage(activeTabId, { type: 'SET_ENABLED', enabled: true }).catch(() => undefined);
    }
  }

  // Auto-switch source to 'selection' if the page has a live text selection.
  // Must happen before applySettingsToUI so the segmented control reflects it.
  const hasSelection = await detectPageSelection();
  if (hasSelection) {
    settings = { ...settings, source: 'selection' };
  }

  applySettingsToUI(settings);

  const bgState = await requestState();
  if (bgState) {
    applyPlayerState(bgState);
  }
  populateVoices(playerState.voices, settings.voiceId);
  wireEvents();
}

/**
 * Ask the active tab's content script whether there is a non-empty
 * text selection right now. Returns false on any error (e.g. the script
 * isn't injected yet, or it's a restricted page).
 */
async function detectPageSelection(): Promise<boolean> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return false;
    type SelectionResponse = { hasSelection: boolean };
    const response = await chrome.scripting.executeScript<[], SelectionResponse>({
      target: { tabId: tab.id },
      func:   () => ({ hasSelection: window.getSelection()?.toString().trim() !== '' }),
    });
    return response[0]?.result?.hasSelection ?? false;
  } catch {
    return false;
  }
}

init().catch(err => showError(String(err)));

// ---------------------------------------------------------------------------
// Background communication
// ---------------------------------------------------------------------------

async function sendToBackground<T>(msg: BackgroundMessage): Promise<T | null> {
  try {
    const response = await chrome.runtime.sendMessage<BackgroundMessage, BackgroundResponse>(msg);
    if (!response) return null;
    if (!response.ok) {
      showError(response.error);
      return null;
    }
    return response as unknown as T;
  } catch (err) {
    // Extension may not be ready or background hasn't started yet
    showError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function requestState(): Promise<PlayerStatePayload | null> {
  const res = await sendToBackground<{ ok: true; state: PlayerStatePayload }>({
    type: 'GET_STATE',
  });
  return res?.state ?? null;
}

async function sendCommand(
  command: 'PLAY' | 'PAUSE' | 'RESUME' | 'STOP',
  extra?: {
    trigger?: 'selection' | 'page' | 'paste';
    pasteText?: string;
    tabId?: number;
  },
): Promise<void> {
  const res = await sendToBackground<{ ok: true; state: PlayerStatePayload }>({
    type:      'PLAYBACK_COMMAND',
    command,
    trigger:   extra?.trigger,
    pasteText: extra?.pasteText,
    tabId:     extra?.tabId,
  });
  if (res?.state) applyPlayerState(res.state);
}

async function getActiveTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listen for state pushes from the background (while popup is open)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; state?: PlayerStatePayload };
  if (msg.type === 'STATE_UPDATE' && msg.state) {
    applyPlayerState(msg.state);
  }
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents(): void {
  // Transport
  btnPlay.addEventListener('click',   () => {
    if (playerState.status === 'paused') {
      void sendCommand('RESUME');
      return;
    }
    void play();
  });
  btnPause.addEventListener('click',  () => sendCommand('PAUSE'));
  btnResume.addEventListener('click', () => sendCommand('RESUME'));
  btnStop.addEventListener('click',   () => sendCommand('STOP'));

  // Source segmented control
  segBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const src = btn.dataset['source'] as ExtractionSource;
      setActiveSource(src);
      persistSetting({ source: src });
    });
  });

  // Voice dropdown
  voiceSelect.addEventListener('change', () => {
    const voiceId = voiceSelect.value;
    persistSetting({ voiceId });
    updateKokoroSpeedNote();
    chrome.runtime.sendMessage({ type: 'SET_VOICE', voiceId }).catch(() => undefined);
  });

  // Sliders
  rangeRate.addEventListener('input', () => {
    const v = parseFloat(rangeRate.value);
    valRate.textContent = `${v.toFixed(2)}×`;
    persistSetting({ rate: v });
    updateKokoroSpeedNote();
    // Apply immediately — tells the offscreen to restart at the new speed
    // without waiting for the next chunk or for the debounce to flush.
    chrome.runtime.sendMessage({ type: 'SET_RATE', rate: v }).catch(() => undefined);
  });

  rangePitch.addEventListener('input', () => {
    const v = parseFloat(rangePitch.value);
    valPitch.textContent = `${v.toFixed(2)}×`;
    persistSetting({ pitch: v });
  });

  rangeVolume.addEventListener('input', () => {
    const v = parseFloat(rangeVolume.value);
    valVolume.textContent = `${Math.round(v * 100)}%`;
    persistSetting({ volume: v });
  });

  // Auto-scroll checkbox
  chkScroll.addEventListener('change', () => {
    persistSetting({ autoScroll: chkScroll.checked });
  });

  // Enable / disable toggle
  chkEnabled.addEventListener('change', () => {
    const enabled = chkEnabled.checked;
    applyEnabledUI(enabled);
    persistSetting({ enabled });
    // Tell the background to update badge + stop playback if disabling
    void getActiveTabId().then(tabId => {
      chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled, tabId }).catch(() => undefined);
    });
  });
}

// ---------------------------------------------------------------------------
// Play — reads paste textarea text if source is 'paste', else triggers page
// ---------------------------------------------------------------------------

async function play(): Promise<void> {
  clearError();

  if (!settings.enabled) {
    showError('Turn on Read Aloud to start listening.');
    return;
  }

  const tabId = await getActiveTabId();
  if (!tabId) {
    showError('Open a webpage, then try again.');
    return;
  }

  // Flush the current in-memory settings to storage immediately, bypassing the
  // 300 ms debounce.  This guarantees the player reads the correct rate /
  // pitch / volume / voiceId when it calls loadSettings() during playback,
  // even if the user changed a slider right before clicking Play.
  clearTimeout(saveTimer);
  await saveSettings(settings).catch(err => showError(String(err)));

  if (settings.source === 'fallback') {
    const text = pasteArea.value.trim();
    if (text) {
      await sendCommand('PLAY', { trigger: 'paste', pasteText: text, tabId });
      return;
    }
    // No pasted text — fall through to full-page extraction
    await sendCommand('PLAY', { trigger: 'page', tabId });
    return;
  }

  const trigger = settings.source === 'selection' ? 'selection' : 'page';
  await sendCommand('PLAY', { trigger, tabId });
}

// ---------------------------------------------------------------------------
// Reflect settings → UI
// ---------------------------------------------------------------------------

function applySettingsToUI(s: ReadAloudSettings): void {
  rangeRate.value         = String(s.rate);
  rangePitch.value        = String(s.pitch);
  rangeVolume.value       = String(s.volume);
  valRate.textContent     = `${s.rate.toFixed(2)}×`;
  valPitch.textContent    = `${s.pitch.toFixed(2)}×`;
  valVolume.textContent   = `${Math.round(s.volume * 100)}%`;
  chkScroll.checked       = s.autoScroll;
  updateKokoroSpeedNote();
  setActiveSource(s.source);
}

function updateKokoroSpeedNote(): void {
  const isKokoro = voiceSelect.value.startsWith('kokoro:');
  kokoroSpeedNote.classList.toggle('hidden', !isKokoro);
  rangeRate.max = String(isKokoro ? KOKORO_MAX_RATE : BROWSER_MAX_RATE);

  if (isKokoro && parseFloat(rangeRate.value) > KOKORO_MAX_RATE) {
    rangeRate.value = String(KOKORO_MAX_RATE);
    valRate.textContent = `${KOKORO_MAX_RATE.toFixed(2)}×`;
    persistSetting({ rate: KOKORO_MAX_RATE });
    chrome.runtime.sendMessage({
      type: 'SET_RATE',
      rate: KOKORO_MAX_RATE,
    }).catch(() => undefined);
  }
}

function setActiveSource(source: ExtractionSource): void {
  settings = { ...settings, source };
  segBtns.forEach(btn => {
    const isActive = btn.dataset['source'] === source;
    btn.classList.toggle('seg-btn--active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  // Show paste area only when "Full text" is chosen and user wants to paste
  const showPaste = source === 'fallback';
  pasteArea.classList.toggle('hidden', !showPaste);
}

// ---------------------------------------------------------------------------
// Reflect player state → UI
// ---------------------------------------------------------------------------

function applyPlayerState(state: PlayerStatePayload): void {
  playerState = state;
  clearError();

  // 1. Status badge
  const { status } = state;
  statusBadge.textContent = STATUS_LABEL[status];
  statusBadge.className   = `badge badge--${status}`;

  // 2. Transport buttons
  const playing = status === 'playing';
  const paused  = status === 'paused';
  const idle    = status === 'idle' || status === 'error';

  btnPlay.disabled   = playing || status === 'loading';
  btnPause.disabled  = !playing;
  btnStop.disabled   = idle;

  btnPlay.title = paused ? 'Resume' : 'Play';
  btnPlay.setAttribute('aria-label', paused ? 'Resume' : 'Play');
  btnPlay.classList.remove('hidden');
  btnResume.classList.add('hidden');

  // 3. Progress
  const { chunkIndex, totalChunks } = state;
  const pct = totalChunks > 0 ? Math.round((chunkIndex / totalChunks) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', String(pct));
  progressLabel.textContent =
    totalChunks > 0 ? `Part ${chunkIndex + 1} of ${totalChunks}` : '—';

  // 4. Error
  if (status === 'error' && state.errorMessage) {
    showError(state.errorMessage);
  }

  // 5. Refresh voices if background sent an updated list
  if (state.voices.length > 0) {
    populateVoices(state.voices, settings.voiceId);
  }
}

const STATUS_LABEL: Record<PlayerStatus, string> = {
  idle:    'Ready',
  loading: 'Preparing…',
  playing: 'Reading',
  paused:  'Paused',
  error:   'Needs attention',
};

// ---------------------------------------------------------------------------
// Voice dropdown
// ---------------------------------------------------------------------------

function populateVoices(
  voices: PlayerStatePayload['voices'],
  selectedId: string,
): void {
  // Don't thrash the DOM if the list hasn't changed
  const newIds = voices.map(v => v.id).join(',');
  if (newIds === voiceSelect.dataset['voiceIds']) {
    if (Array.from(voiceSelect.options).some(o => o.value === selectedId)) {
      voiceSelect.value = selectedId;
    }
    updateKokoroSpeedNote();
    return;
  }
  voiceSelect.dataset['voiceIds'] = newIds;

  const current = voiceSelect.value;
  voiceSelect.innerHTML = '<option value="">Automatic (recommended)</option>';

  // Classify each voice: "natural" quality voices get their own group at the top
  const NATURAL_RE = /natural|neural|online|enhanced|premium|wavenet|studio|multilingual|google|siri|\bhd\b/i;

  const kokoro:   PlayerStatePayload['voices'] = [];
  const natural:  PlayerStatePayload['voices'] = [];
  const standard: PlayerStatePayload['voices'] = [];

  for (const v of voices) {
    if (v.id.startsWith('kokoro:')) {
      kokoro.push(v);
    } else {
      (NATURAL_RE.test(v.name) ? natural : standard).push(v);
    }
  }

  const makeOption = (v: PlayerStatePayload['voices'][number]): HTMLOptionElement => {
    const opt      = document.createElement('option');
    opt.value      = v.id;
    const quality  = NATURAL_RE.test(v.name) ? '⭐ ' : '';
    const cloud    = v.local ? '' : ' ☁';
    opt.textContent = `${quality}${v.name} (${v.lang})${cloud}`;
    return opt;
  };

  if (kokoro.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = 'Kokoro local AI — downloads once';
    kokoro.forEach(v => grp.appendChild(makeOption(v)));
    voiceSelect.appendChild(grp);
  }

  if (natural.length > 0) {
    const grp   = document.createElement('optgroup');
    grp.label   = 'Natural and neural voices';
    natural.forEach(v => grp.appendChild(makeOption(v)));
    voiceSelect.appendChild(grp);
  }

  if (standard.length > 0) {
    const grp   = document.createElement('optgroup');
    grp.label   = 'Standard voices';
    standard.forEach(v => grp.appendChild(makeOption(v)));
    voiceSelect.appendChild(grp);
  }

  // Auto-select best natural voice for the page language if no saved preference.
  // Prefer voices matching navigator.language, then any natural voice.
  const preferred = selectedId || current;
  if (preferred && Array.from(voiceSelect.options).some(o => o.value === preferred)) {
    voiceSelect.value = preferred;
  } else if (natural.length > 0) {
    // Pick the natural voice that best matches the user's language
    const lang   = (navigator.language || 'en').toLowerCase();
    const prefix = lang.split('-')[0] ?? lang;
    const match  =
      natural.find(v => v.lang.toLowerCase() === lang) ??
      natural.find(v => v.lang.toLowerCase().startsWith(prefix)) ??
      natural[0];
    if (match) {
      voiceSelect.value = match.id;
      persistSetting({ voiceId: match.id });
    }
  }
  updateKokoroSpeedNote();
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function showError(msg: string): void {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function clearError(): void {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Enable / disable UI overlay
// ---------------------------------------------------------------------------

function applyEnabledUI(enabled: boolean): void {
  document.body.classList.toggle('extension-disabled', !enabled);
  chkEnabled.checked = enabled;
}

// ---------------------------------------------------------------------------
// Settings persistence (debounced)
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function persistSetting(patch: Partial<ReadAloudSettings>): void {
  settings = { ...settings, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveSettings(settings).catch(err => showError(String(err)));
  }, 300);
}
