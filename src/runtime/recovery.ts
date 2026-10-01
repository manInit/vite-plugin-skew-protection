/**
 * The inline script that is injected at the top of <head> (right after `<meta charset>` when there is one).
 *
 * The script runs before the app. When a chunk fails to load, it reloads the page once,
 * so the user gets the new deploy instead of a blank screen:
 *
 * - It listens to `vite:preloadError` and to unhandled promise rejections whose message
 *   looks like a failed dynamic import (Chrome, Firefox and Safari word it differently).
 * - Before reloading it dispatches a cancelable `skew:reload` event, so the app can
 *   call `preventDefault()` and show its own message instead.
 * - It remembers the time of the last reload in sessionStorage. If the page fails again
 *   within `cooldownMs`, the reload didn't help, so it stops instead of reloading forever.
 *   If sessionStorage is not available, it never reloads, because it couldn't stop a loop.
 * - It does nothing while the browser is offline: the chunk failed because of the network, not a deploy.
 *
 * It is shipped to browsers as it is, so it is compiled at build time into a minified ES5 IIFE
 * (see `build/inline-script.ts`). ES5 has no `let`/`const` and destructuring: use `var`.
 */

/** Replaced with the real value in `createRecoveryScript`. */
declare var __SKEW_COOLDOWN_MS__: number;

/** Public runtime state, `window.__SKEW_PROTECTION__`. Exporting it also makes this file a module for TypeScript. */
export interface RecoveryState {
  reloading: boolean;
}

declare global {
  interface Window {
    __SKEW_PROTECTION__?: RecoveryState;
  }
}

var cooldownMs = __SKEW_COOLDOWN_MS__;
var storageKey = 'vite-skew-protection:reloaded-at';
var chunkErrorMessage =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;
var state: RecoveryState = { reloading: false };
window.__SKEW_PROTECTION__ = state;

function reloadedRecently(): boolean {
  var lastReloadTime = Number(sessionStorage.getItem(storageKey)) || 0;
  return Date.now() - lastReloadTime < cooldownMs;
}

function appCancelledReload(error: unknown): boolean {
  var event;
  try {
    event = new CustomEvent('skew:reload', { cancelable: true, detail: { error: error } });
  } catch {
    // Old browsers without the CustomEvent constructor: nobody could cancel the reload.
    return false;
  }
  var notCancelled = window.dispatchEvent(event);
  return !notCancelled;
}

function reloadOnce(error: unknown): boolean {
  if (state.reloading) {
    return true;
  }
  // A chunk that failed because the network is gone looks the same. A reload wouldn't help
  // and would throw away the state of the app.
  if (navigator.onLine === false) {
    return false;
  }
  try {
    if (reloadedRecently()) {
      return false;
    }
  } catch {
    // sessionStorage is not available: without it we can't stop a reload loop.
    return false;
  }
  if (appCancelledReload(error)) {
    return false;
  }
  try {
    // Saved only when the page really reloads, so a cancelled reload doesn't silence the next event.
    sessionStorage.setItem(storageKey, String(Date.now()));
  } catch {
    return false;
  }
  state.reloading = true;
  window.location.reload();
  return true;
}

window.addEventListener('vite:preloadError', function (event) {
  reloadOnce((event as Event & { payload: unknown }).payload);
});

window.addEventListener('unhandledrejection', function (event) {
  var error = event.reason;
  var message = error && error.message ? error.message : String(error);
  if (chunkErrorMessage.test(message) && reloadOnce(error)) {
    event.preventDefault();
  }
});
