/**
 * OCR for screen-region captures, running in the main process with
 * tesseract.js (node worker threads). The English model (~2 MB gzip) is
 * downloaded once and cached under the app's userData directory.
 */

import { app } from 'electron';
import * as path from 'node:path';
import { createWorker, type Worker } from 'tesseract.js';

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      cachePath: path.join(app.getPath('userData'), 'tessdata'),
    }).catch((error: unknown) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

/** Extract text from a PNG screenshot. Returns '' when nothing was found. */
export async function recognizeText(png: Buffer): Promise<string> {
  const worker = await getWorker();
  const { data } = await worker.recognize(png);
  return normalizeOcrText(data.text ?? '');
}

export async function disposeOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  await pending.then(worker => worker.terminate()).catch(() => undefined);
}

/**
 * OCR output keeps visual line breaks; rejoin lines within a paragraph so
 * the chunker doesn't treat every screen line as its own paragraph.
 */
function normalizeOcrText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(paragraph => paragraph.length > 0)
    .join('\n');
}
