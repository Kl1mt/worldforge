import { useEffect, useState } from 'react';
import { inboxApi } from './api';

/** How often the shell asks for the unread count while the tab is visible (docs/NOTIFICATIONS.md). */
export const INBOX_POLL_MS = 60_000;
/** Fired on `window` when the inbox changed here (read, mark all): the badge asks again at once. */
export const INBOX_CHANGED_EVENT = 'wf:inbox';

export function announceInboxChange() {
  window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
}

/**
 * The shell's unread badge (ticket 8.5): `GET /api/inbox/summary` every minute while the tab is
 * visible, at once when it becomes visible again or the inbox changed here. The summary has an
 * `ETag`, so an unchanged count is a `304`. A failed poll keeps the last count.
 */
export function useInboxUnread(pollMs = INBOX_POLL_MS): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'hidden') return;
      inboxApi.summary(controller.signal).then(
        (res) => {
          if (res.ok) setUnread(res.value.unread);
          if (pollMs > 0) timer = setTimeout(poll, pollMs);
        },
        () => {
          /* aborted */
        },
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    poll();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(INBOX_CHANGED_EVENT, poll);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(INBOX_CHANGED_EVENT, poll);
    };
  }, [pollMs]);
  return unread;
}
