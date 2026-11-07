/**
 * Ticket F.4: after a deploy, an open tab's old build can no longer fetch its lazily loaded
 * files (their hashed names are gone). Browsers word the failure differently; these are the
 * messages for a dynamic `import()` or a stylesheet preload that could not load.
 */
const CHUNK_MESSAGES = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /unable to preload css/i, // Vite's stylesheet preload
  /loading (css )?chunk \S+ failed/i, // older bundlers
];

export function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && CHUNK_MESSAGES.some((re) => re.test(message));
}

/**
 * Calls `onFail` when a part of the build fails to load: Vite's `vite:preloadError` event (fired
 * on `window` before a lazy import rejects) or an unhandled rejection that is a chunk error.
 * The error itself is left to propagate, so a screen's error boundary still shows its own
 * reload panel. Returns an unsubscribe.
 */
export function watchChunkErrors(target: EventTarget, onFail: () => void): () => void {
  const onPreload = () => onFail();
  const onRejection = (event: Event) => {
    if (isChunkLoadError((event as PromiseRejectionEvent).reason)) onFail();
  };
  target.addEventListener('vite:preloadError', onPreload);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('vite:preloadError', onPreload);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Reload the page (the player's choice; never automatic). */
export function reloadPage(): void {
  window.location.reload();
}
