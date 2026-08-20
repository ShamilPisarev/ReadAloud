/**
 * Capture the text currently selected in ANY application by simulating the
 * platform copy keystroke and reading the clipboard, then restoring it.
 *
 * Windows: a persistent PowerShell helper process sends Ctrl+C via
 *          WScript.Shell.SendKeys (spawning PowerShell per keystroke would
 *          cost 1–2 s; the resident loop reacts instantly).
 * macOS:   osascript tells System Events to press Cmd+C. The first use asks
 *          the user to grant Accessibility permission to the app.
 */

import { clipboard } from 'electron';
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type KeySenderProcess = ChildProcessByStdio<Writable, Readable, null>;

const CLIPBOARD_POLL_MS = 60;
const CLIPBOARD_WAIT_MS = 2_000;
/**
 * Give the user a beat to release the hotkey's modifier keys first.
 * On Windows the helper additionally polls GetAsyncKeyState and waits for a
 * full release — a physically held Alt would otherwise turn the injected
 * Ctrl+C into Ctrl+Alt+C, which most apps don't treat as "copy".
 */
const MODIFIER_RELEASE_MS = 80;
const MODIFIER_RELEASE_DARWIN_MS = 400;

let keySender: KeySenderProcess | null = null;
let keySenderReady: Promise<void> | null = null;

const WINDOWS_SENDER_SCRIPT = `
Add-Type -Name Keys -Namespace Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);'
$shell = New-Object -ComObject WScript.Shell
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'copy') {
    # Wait until Shift/Ctrl/Alt/Win are all physically released (max 1.5 s)
    # so the injected Ctrl+C is not polluted by held hotkey modifiers.
    $deadline = [DateTime]::Now.AddMilliseconds(1500)
    while ([DateTime]::Now -lt $deadline) {
      $held = $false
      foreach ($vk in 0x10, 0x11, 0x12, 0x5B, 0x5C) {
        if (([Win32.Keys]::GetAsyncKeyState($vk) -band 0x8000) -ne 0) { $held = $true; break }
      }
      if (-not $held) { break }
      Start-Sleep -Milliseconds 30
    }
    $shell.SendKeys('^c')
    [Console]::Out.WriteLine('done')
    [Console]::Out.Flush()
  }
}
`.trim();

function ensureWindowsSender(): Promise<void> {
  if (keySender && keySenderReady) return keySenderReady;

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SENDER_SCRIPT],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  );
  child.stdout.setEncoding('utf8');
  child.on('exit', () => {
    keySender = null;
    keySenderReady = null;
  });
  keySender = child;
  keySenderReady = waitForLine(child, 'ready', 10_000);
  return keySenderReady;
}

function waitForLine(
  child: KeySenderProcess,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`Timed out waiting for key sender "${expected}"`));
    }, timeoutMs);
    const onData = (data: string): void => {
      if (data.includes(expected)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
  });
}

async function sendCopyKeystroke(): Promise<void> {
  if (process.platform === 'darwin') {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "c" using command down'],
        error => {
          if (error) {
            reject(new Error(
              'Could not simulate Cmd+C. Grant Read Aloud the Accessibility '
              + 'permission in System Settings → Privacy & Security.',
            ));
          } else {
            resolve();
          }
        },
      );
    });
    return;
  }

  await ensureWindowsSender();
  const child = keySender;
  if (!child) throw new Error('Key sender process is not running.');
  const done = waitForLine(child, 'done', 5_000);
  child.stdin.write('copy\n');
  await done;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns the selected text, or '' when nothing was selected / the frontmost
 * app does not respond to the copy keystroke. Restores the previous clipboard
 * text afterwards (text only — image clipboard content is not preserved).
 */
export async function captureSelectionText(): Promise<string> {
  const previous = clipboard.readText();
  clipboard.clear();

  await delay(
    process.platform === 'darwin' ? MODIFIER_RELEASE_DARWIN_MS : MODIFIER_RELEASE_MS,
  );
  await sendCopyKeystroke();

  let captured = '';
  const deadline = Date.now() + CLIPBOARD_WAIT_MS;
  while (Date.now() < deadline) {
    captured = clipboard.readText();
    if (captured.trim()) break;
    await delay(CLIPBOARD_POLL_MS);
  }

  if (previous) clipboard.writeText(previous);
  return captured.trim();
}

/** Warm the Windows helper at startup so the first capture is instant. */
export function preloadKeySender(): void {
  if (process.platform === 'win32') {
    void ensureWindowsSender().catch(() => undefined);
  }
}

export function disposeKeySender(): void {
  keySender?.kill();
  keySender = null;
  keySenderReady = null;
}
