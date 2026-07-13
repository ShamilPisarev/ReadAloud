import type { Chunk, ExtractionResult } from './text/types';
import type { EngineId } from './speech/types';

// ---------------------------------------------------------------------------
// Direction: Popup / Background  →  Content Script
// ---------------------------------------------------------------------------

/** Ask the content script to extract text and return chunks. */
export interface ExtractTextMessage {
  type: 'EXTRACT_TEXT';
  /**
   * When true: extract the full page/article text (ignoring any selection),
   * then return the chunk index where the current selection begins so playback
   * can start mid-page ("read from here" feature).
   */
  fromSelectionStart?: boolean;
}

/** Tell the content script to highlight and optionally scroll to a chunk. */
export interface HighlightChunkMessage {
  type: 'HIGHLIGHT_CHUNK';
  chunkIndex: number;
  scroll: boolean;
}

/** Tell the content script to highlight a specific word within the current chunk. */
export interface HighlightWordMessage {
  type: 'HIGHLIGHT_WORD';
  /** Char offset of the word within the current chunk's text. */
  charIndex: number;
  charLength: number;
}

/** Tell the content script to clear all highlights. */
export interface ClearHighlightMessage {
  type: 'CLEAR_HIGHLIGHT';
}

/** Tell the content script whether the browser-action popup is currently open. */
export interface PopupVisibilityMessage {
  type: 'POPUP_VISIBILITY';
  open: boolean;
}

/** Union of all messages the content script can receive. */
export type ContentScriptMessage =
  | ExtractTextMessage
  | HighlightChunkMessage
  | HighlightWordMessage
  | PopupVisibilityMessage
  | ClearHighlightMessage;

// ---------------------------------------------------------------------------
// Direction: Content Script  →  Background / Popup
// ---------------------------------------------------------------------------

/** Content script's response to EXTRACT_TEXT. */
export interface ExtractTextResponse {
  ok: true;
  source: ExtractionResult['source'];
  text: string;
  chunks: Chunk[];
  /** Populated when the request had `fromSelectionStart: true`. */
  startChunkIndex?: number;
}

/** Sent when extraction or highlighting fails. */
export interface ErrorResponse {
  ok: false;
  error: string;
}

export type ContentScriptResponse = ExtractTextResponse | ErrorResponse;

// ---------------------------------------------------------------------------
// Direction: Background  →  Offscreen document
// ---------------------------------------------------------------------------

/** Ask the offscreen document to speak a single chunk of text. */
export interface SpeakChunkMessage {
  type: 'SPEAK_CHUNK';
  text: string;
  voiceId?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
}

export interface PauseMessage  { type: 'PAUSE'  }
export interface ResumeMessage { type: 'RESUME' }
export interface StopMessage   { type: 'STOP'   }

/** Background tells offscreen to change playback rate immediately (restarts utterance). */
export interface SetRateMessage { type: 'SET_RATE'; rate: number }

/** Start loading a selected local voice before the user presses Play. */
export interface PreloadVoiceMessage { type: 'PRELOAD_VOICE'; voiceId: string }

/**
 * Background asks offscreen to return the available SpeechSynthesis voices.
 * The offscreen responds with `{ ok: true; voices: Array<...> }`.
 */
export interface GetVoicesRequestMessage { type: 'GET_VOICES_REQUEST' }

/** Union of all messages the offscreen document can receive. */
export type OffscreenMessage =
  | SpeakChunkMessage
  | PauseMessage
  | ResumeMessage
  | StopMessage
  | SetRateMessage
  | PreloadVoiceMessage
  | GetVoicesRequestMessage;

// ---------------------------------------------------------------------------
// Direction: Popup  →  Background service worker
// ---------------------------------------------------------------------------

export type PlaybackCommand = 'PLAY' | 'PAUSE' | 'RESUME' | 'STOP';

/** Popup tells background to start playing, using the current settings. */
export interface PlaybackCommandMessage {
  type: 'PLAYBACK_COMMAND';
  command: PlaybackCommand;
  /** For paste-mode PLAY: text typed/pasted in the popup textarea. */
  pasteText?: string;
  /** Trigger override — inferred from source setting when omitted. */
  trigger?: 'selection' | 'page' | 'paste' | 'from-here';
  /** Explicit target tab when the sender already knows it. */
  tabId?: number;
}

/** Popup asks background for the current player state + available voices. */
export interface GetStateMessage {
  type: 'GET_STATE';
}

/** Popup asks background to apply a new rate immediately (even mid-playback). */
export interface SetRateBackgroundMessage {
  type: 'SET_RATE';
  rate: number;
}

/** Ask the background to switch voices immediately during playback. */
export interface SetVoiceBackgroundMessage {
  type: 'SET_VOICE';
  voiceId: string;
}

/** Union of all background-bound messages from the popup. */
export type BackgroundMessage =
  | PlaybackCommandMessage
  | GetStateMessage
  | SetRateBackgroundMessage
  | SetVoiceBackgroundMessage;

// ---------------------------------------------------------------------------
// Direction: Background  →  Popup (state push / response)
// ---------------------------------------------------------------------------

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerStatePayload {
  status:       PlayerStatus;
  chunkIndex:   number;
  totalChunks:  number;
  errorMessage: string | null;
  /** Serialisable voice list for the popup's dropdown. */
  voices: Array<{ id: string; name: string; lang: string; local: boolean }>;
}

export interface StateResponse {
  ok: true;
  state: PlayerStatePayload;
}

export type BackgroundResponse = StateResponse | ErrorResponse;

// ---------------------------------------------------------------------------
// Direction: Offscreen document  →  Background service worker
// ---------------------------------------------------------------------------

/** Offscreen signals that the current chunk finished (ok) or errored. */
export interface ChunkDoneMessage {
  type: 'CHUNK_DONE';
  ok: boolean;
  error?: string;
  /** Engine that completed the chunk, used to ignore stale completions. */
  engine?: EngineId;
}

/**
 * Offscreen fires a word boundary event so the content script can highlight
 * the current spoken word in real time.
 */
export interface WordBoundaryMessage {
  type: 'WORD_BOUNDARY';
  /** Char offset within the chunk text where the word starts. */
  charIndex: number;
  /** Number of chars in the word. */
  charLength: number;
  engine?: EngineId;
}

export interface EngineStatusMessage {
  type: 'ENGINE_STATUS';
  engine: EngineId;
  status: 'loading' | 'ready';
}

/** Offscreen asks background to retrieve voices (chrome.tts) on its behalf. */
export interface GetVoicesMessage {
  type: 'GET_VOICES';
}

export type OffscreenToBackground =
  | ChunkDoneMessage
  | GetVoicesMessage
  | WordBoundaryMessage
  | EngineStatusMessage;

// ---------------------------------------------------------------------------
// Direction: Background  →  Popup (unsolicited state push)
// ---------------------------------------------------------------------------

/** Background pushes state changes to any open popup. */
export interface StateUpdateMessage {
  type: 'STATE_UPDATE';
  state: PlayerStatePayload;
}
