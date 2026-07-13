import { loadSettings, saveSettings, type ReadAloudSettings } from '../lib/storage';
import type { PlayerStatePayload } from '../lib/messages';

const TOOLBAR_ID = 'read-aloud-toolbar-root';
const STYLE_ID   = 'read-aloud-toolbar-style';

const TOOLBAR_CSS = `
#${TOOLBAR_ID} {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  width: min(760px, calc(100vw - 24px));
  pointer-events: none;
  font-family: "Segoe UI", "SF Pro Text", Arial, sans-serif;
}

#${TOOLBAR_ID}[data-hidden="true"] {
  display: none;
}

#${TOOLBAR_ID} .ra-shell {
  pointer-events: auto;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid rgba(22, 31, 48, 0.12);
  background: linear-gradient(180deg, rgba(250, 247, 239, 0.98), rgba(245, 239, 225, 0.96));
  box-shadow: 0 18px 40px rgba(18, 24, 35, 0.18);
  backdrop-filter: blur(14px);
  color: #1d2430;
}

#${TOOLBAR_ID} .ra-main {
  display: grid;
  gap: 8px;
  min-width: 0;
}

#${TOOLBAR_ID} .ra-top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

#${TOOLBAR_ID} .ra-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 80px;
  padding: 4px 9px;
  border-radius: 999px;
  background: #1d2430;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

#${TOOLBAR_ID} .ra-badge[data-status="paused"] { background: #8a5a00; }
#${TOOLBAR_ID} .ra-badge[data-status="loading"] { background: #355c7d; }
#${TOOLBAR_ID} .ra-badge[data-status="error"] { background: #9c2f2f; }

#${TOOLBAR_ID} .ra-progress-text {
  font-size: 13px;
  color: #4c5667;
  white-space: nowrap;
}

#${TOOLBAR_ID} .ra-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #596579;
}

#${TOOLBAR_ID} .ra-progress {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: rgba(35, 43, 57, 0.12);
  overflow: hidden;
}

#${TOOLBAR_ID} .ra-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  border-radius: inherit;
  background: linear-gradient(90deg, #ff8f00, #ffca28);
}

#${TOOLBAR_ID} .ra-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

#${TOOLBAR_ID} .ra-controls,
#${TOOLBAR_ID} .ra-settings {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

#${TOOLBAR_ID} .ra-btn,
#${TOOLBAR_ID} .ra-close {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 9px 12px;
  background: #1f2937;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

#${TOOLBAR_ID} .ra-btn[disabled] {
  opacity: 0.45;
  cursor: default;
}

#${TOOLBAR_ID} .ra-btn--secondary {
  background: #d9dde5;
  color: #1f2937;
}

#${TOOLBAR_ID} .ra-close {
  align-self: start;
  width: 38px;
  height: 38px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(31, 41, 55, 0.08);
  color: #1f2937;
  font-size: 18px;
}

#${TOOLBAR_ID} label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #445064;
  font-weight: 600;
}

#${TOOLBAR_ID} select,
#${TOOLBAR_ID} input[type="range"] {
  accent-color: #ff8f00;
}

#${TOOLBAR_ID} select {
  min-width: 220px;
  max-width: 320px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(31, 41, 55, 0.16);
  background: rgba(255, 255, 255, 0.82);
  color: #1f2937;
}

#${TOOLBAR_ID} .ra-rate {
  width: 120px;
}

#${TOOLBAR_ID} .ra-rate-value {
  min-width: 38px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: #1f2937;
}

@media (max-width: 720px) {
  #${TOOLBAR_ID} .ra-shell {
    grid-template-columns: 1fr;
  }

  #${TOOLBAR_ID} .ra-close {
    justify-self: end;
  }

  #${TOOLBAR_ID} .ra-settings {
    width: 100%;
  }

  #${TOOLBAR_ID} select {
    max-width: 100%;
    min-width: 160px;
    flex: 1 1 220px;
  }
}
`.trim();

type ToolbarCallbacks = {
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRate: (rate: number) => void;
  onVoice: (voiceId: string) => void;
  onDismiss: () => void;
};

export class ReadingToolbar {
  private readonly callbacks: ToolbarCallbacks;
  private root: HTMLDivElement;
  private badge: HTMLSpanElement;
  private progressFill: HTMLDivElement;
  private progressText: HTMLSpanElement;
  private hint: HTMLSpanElement;
  private playBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private voiceSelect: HTMLSelectElement;
  private rateInput: HTMLInputElement;
  private rateValue: HTMLSpanElement;
  private state: PlayerStatePayload = {
    status: 'idle',
    chunkIndex: 0,
    totalChunks: 0,
    errorMessage: null,
    voices: [],
  };
  private settings: ReadAloudSettings | null = null;
  private dismissed = false;

  constructor(callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.injectStyles();
    this.root = this.createDom();
    this.badge = this.root.querySelector('.ra-badge') as HTMLSpanElement;
    this.progressFill = this.root.querySelector('.ra-progress-fill') as HTMLDivElement;
    this.progressText = this.root.querySelector('.ra-progress-text') as HTMLSpanElement;
    this.hint = this.root.querySelector('.ra-hint') as HTMLSpanElement;
    this.playBtn = this.root.querySelector('[data-action="play"]') as HTMLButtonElement;
    this.pauseBtn = this.root.querySelector('[data-action="pause"]') as HTMLButtonElement;
    this.resumeBtn = this.root.querySelector('[data-action="resume"]') as HTMLButtonElement;
    this.stopBtn = this.root.querySelector('[data-action="stop"]') as HTMLButtonElement;
    this.closeBtn = this.root.querySelector('[data-action="close"]') as HTMLButtonElement;
    this.voiceSelect = this.root.querySelector('[data-role="voice"]') as HTMLSelectElement;
    this.rateInput = this.root.querySelector('[data-role="rate"]') as HTMLInputElement;
    this.rateValue = this.root.querySelector('.ra-rate-value') as HTMLSpanElement;
    this.wireEvents();
    document.documentElement.appendChild(this.root);
    this.render();
  }

  async init(): Promise<void> {
    this.settings = await loadSettings();
    this.applySettings(this.settings);
  }

  applyState(state: PlayerStatePayload): void {
    if (this.state.status === 'idle' && state.status !== 'idle') {
      this.dismissed = false;
    }
    if (state.status === 'idle') {
      this.dismissed = false;
    }
    this.state = state;
    this.render();
  }

  applySettings(settings: ReadAloudSettings): void {
    this.settings = settings;
    this.rateInput.value = String(settings.rate);
    this.rateValue.textContent = `${settings.rate.toFixed(2)}x`;
    this.populateVoices(this.state.voices, settings.voiceId);
    this.render();
  }

  isEventInside(target: EventTarget | null): boolean {
    return target instanceof Node && this.root.contains(target);
  }

  reveal(): void {
    this.dismissed = false;
    this.render();
  }

  private createDom(): HTMLDivElement {
    const root = document.createElement('div');
    root.id = TOOLBAR_ID;
    root.dataset['hidden'] = 'true';
    root.innerHTML = `
      <div class="ra-shell" role="dialog" aria-label="Reading controls">
        <div class="ra-main">
          <div class="ra-top">
            <span class="ra-badge" data-status="idle">Ready</span>
            <span class="ra-progress-text">-</span>
            <span class="ra-hint">Double-click any text to continue reading from that point.</span>
          </div>
          <div class="ra-progress" aria-hidden="true">
            <div class="ra-progress-fill"></div>
          </div>
          <div class="ra-bottom">
            <div class="ra-controls">
              <button class="ra-btn" data-action="play" type="button">Play</button>
              <button class="ra-btn ra-btn--secondary" data-action="pause" type="button">Pause</button>
              <button class="ra-btn ra-btn--secondary" data-action="resume" type="button">Resume</button>
              <button class="ra-btn ra-btn--secondary" data-action="stop" type="button">Stop</button>
            </div>
            <div class="ra-settings">
              <label>
                Voice
                <select data-role="voice">
                  <option value="">Automatic (recommended)</option>
                </select>
              </label>
              <label>
                Speed
                <input class="ra-rate" data-role="rate" type="range" min="0.5" max="4" step="0.05" value="1" />
                <span class="ra-rate-value">1.00x</span>
              </label>
            </div>
          </div>
        </div>
        <button class="ra-close" data-action="close" type="button" aria-label="Hide reading controls">×</button>
      </div>
    `;
    return root;
  }

  private wireEvents(): void {
    this.playBtn.addEventListener('click', () => this.callbacks.onPlay());
    this.pauseBtn.addEventListener('click', () => this.callbacks.onPause());
    this.resumeBtn.addEventListener('click', () => this.callbacks.onResume());
    this.stopBtn.addEventListener('click', () => this.callbacks.onStop());
    this.closeBtn.addEventListener('click', () => {
      this.dismissed = true;
      this.callbacks.onDismiss();
      this.render();
    });
    this.rateInput.addEventListener('input', () => {
      const rate = parseFloat(this.rateInput.value);
      this.rateValue.textContent = `${rate.toFixed(2)}x`;
      void saveSettings({ rate });
      this.callbacks.onRate(rate);
    });
    this.voiceSelect.addEventListener('change', () => {
      const voiceId = this.voiceSelect.value;
      void saveSettings({ voiceId });
      if (this.settings) {
        this.settings = { ...this.settings, voiceId };
      }
      this.callbacks.onVoice(voiceId);
    });
  }

  private render(): void {
    const active = this.state.status === 'loading' || this.state.status === 'playing' || this.state.status === 'paused';
    this.root.dataset['hidden'] = (!active || this.dismissed) ? 'true' : 'false';

    const labels: Record<PlayerStatePayload['status'], string> = {
      idle: 'Ready',
      loading: 'Preparing',
      playing: 'Reading',
      paused: 'Paused',
      error: 'Needs attention',
    };

    this.badge.textContent = labels[this.state.status];
    this.badge.dataset['status'] = this.state.status;

    const { chunkIndex, totalChunks } = this.state;
    this.progressText.textContent = totalChunks > 0 ? `Part ${chunkIndex + 1} of ${totalChunks}` : '-';
    const progress = totalChunks > 0 ? Math.round((chunkIndex / totalChunks) * 100) : 0;
    this.progressFill.style.width = `${progress}%`;

    if (this.state.errorMessage) {
      this.hint.textContent = this.state.errorMessage;
    } else if (this.state.voices.length === 0) {
      this.hint.textContent = 'Voices will appear here when your browser makes them available.';
    } else if (this.settings?.voiceId.startsWith('kokoro:')) {
      this.hint.textContent = 'Kokoro runs locally. The first playback downloads and caches the model.';
    } else {
      this.hint.textContent = 'Double-click any text to continue reading from that point.';
    }

    const playing = this.state.status === 'playing';
    const paused = this.state.status === 'paused';
    const loading = this.state.status === 'loading';

    this.playBtn.disabled = !(!playing && !loading);
    this.pauseBtn.disabled = !playing;
    this.resumeBtn.disabled = !paused;
    this.stopBtn.disabled = this.state.status === 'idle';

    if (this.settings) {
      this.populateVoices(this.state.voices, this.settings.voiceId);
    }
  }

  private populateVoices(voices: PlayerStatePayload['voices'], selectedId: string): void {
    const ids = voices.map(v => v.id).join(',');
    if (this.voiceSelect.dataset['voiceIds'] === ids && this.voiceSelect.value === selectedId) {
      return;
    }

    this.voiceSelect.dataset['voiceIds'] = ids;
    this.voiceSelect.innerHTML = '<option value="">Automatic (recommended)</option>';

    const naturalVoicePattern = /natural|neural|online|enhanced|premium|wavenet|studio|multilingual|google|siri|\bhd\b/i;
    const kokoroVoices = voices.filter(voice => voice.id.startsWith('kokoro:'));
    const browserVoices = voices.filter(voice => !voice.id.startsWith('kokoro:'));
    const naturalVoices = browserVoices.filter(voice => naturalVoicePattern.test(voice.name));
    const standardVoices = browserVoices.filter(voice => !naturalVoicePattern.test(voice.name));

    const makeOption = (voice: PlayerStatePayload['voices'][number]): HTMLOptionElement => {
      const opt = document.createElement('option');
      opt.value = voice.id;
      opt.textContent = `${voice.name} (${voice.lang || 'language not specified'})`;
      return opt;
    };

    if (kokoroVoices.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Kokoro local AI — downloads once';
      kokoroVoices.forEach(voice => group.appendChild(makeOption(voice)));
      this.voiceSelect.appendChild(group);
    }

    if (naturalVoices.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Natural voices';
      naturalVoices.forEach(voice => group.appendChild(makeOption(voice)));
      this.voiceSelect.appendChild(group);
    }

    if (standardVoices.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Standard voices';
      standardVoices.forEach(voice => group.appendChild(makeOption(voice)));
      this.voiceSelect.appendChild(group);
    }

    if (selectedId && Array.from(this.voiceSelect.options).some(o => o.value === selectedId)) {
      this.voiceSelect.value = selectedId;
    } else {
      this.voiceSelect.value = '';
    }
  }

  private injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = TOOLBAR_CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
}
