import * as vscode from 'vscode';
import { clampWatchIntervalSeconds } from './storageCore';
import { checkForExternalChanges, getStorageFileUri } from './storageService';

let fileWatcher: vscode.FileSystemWatcher | undefined;
let watcherListeners: vscode.Disposable[] = [];
let pollTimer: ReturnType<typeof setInterval> | undefined;
let notifyChange: (() => void) | undefined;
let checking = false;
let checkGuardTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a check may hold the guard before later polls are allowed through. */
const CHECK_GUARD_TIMEOUT_MS = 30_000;

/**
 * Watches the storage file for edits made outside this window — the Obsidian
 * plugin, another VS Code window, another machine through a synced folder.
 *
 * Registers its own teardown on the extension's lifetime.
 */
export function initStorageWatcher(context: vscode.ExtensionContext, onChange: () => void): void {
  notifyChange = onChange;
  context.subscriptions.push(new vscode.Disposable(() => stopWatching()));
  restartStorageWatcher();
}

/** Call whenever the storage path or one of the watch settings changed. */
export function restartStorageWatcher(): void {
  stopWatching();
  if (!notifyChange) return;

  const config = vscode.workspace.getConfiguration('toudou');
  if (!config.get<boolean>('watchExternalChanges', true)) return;

  const uri = getStorageFileUri();
  if (!uri) return;

  startFileWatcher(uri);

  // The watcher is only a low-latency hint: the file typically lives in a synced
  // folder (Synology Drive, OneDrive…) where no reliable event ever arrives.
  // Polling is the source of truth.
  const seconds = clampWatchIntervalSeconds(config.get('watchIntervalSeconds'));
  pollTimer = setInterval(() => void check(), seconds * 1000);
}

function startFileWatcher(uri: vscode.Uri): void {
  // Watch the *directory*, not the file: an atomic write replaces the inode,
  // which silently detaches a file-level watch after the first save.
  const folder = vscode.Uri.joinPath(uri, '..');
  try {
    fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*'));
  } catch {
    // An unmounted or unwatchable drive must not break the extension; the poll
    // loop still covers it.
    fileWatcher = undefined;
    return;
  }

  const onEvent = (changed: vscode.Uri) => {
    // Ignore the siblings, starting with our own `.tmp` files.
    if (changed.toString() === uri.toString()) void check();
  };
  watcherListeners = [
    fileWatcher.onDidCreate(onEvent),
    fileWatcher.onDidChange(onEvent),
    fileWatcher.onDidDelete(onEvent),
  ];
}

function releaseGuard(): void {
  checking = false;
  if (checkGuardTimer !== undefined) {
    clearTimeout(checkGuardTimer);
    checkGuardTimer = undefined;
  }
}

async function check(): Promise<void> {
  // A stat on a sleeping network drive can outlive the poll interval.
  if (checking) return;
  checking = true;
  // …and a stat on a drive that never wakes up can outlive everything. Release
  // the guard on a timer so one hung call does not end the polling for good.
  checkGuardTimer = setTimeout(() => {
    checking = false;
    checkGuardTimer = undefined;
  }, CHECK_GUARD_TIMEOUT_MS);

  try {
    if (await checkForExternalChanges()) notifyChange?.();
  } catch {
    // Read problems are already surfaced by the storage service; a rejection
    // escaping the interval would only add noise to the extension host log.
  } finally {
    releaseGuard();
  }
}

function stopWatching(): void {
  for (const listener of watcherListeners) listener.dispose();
  watcherListeners = [];
  fileWatcher?.dispose();
  fileWatcher = undefined;
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  releaseGuard();
}
