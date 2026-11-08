import { useEffect, useState } from 'react';
import { legalApi } from '../legal/api';

/**
 * Ticket 5.7: whether the server can send mail (`GET /api/config` → `email.enabled`). `null` while
 * unknown (loading, or the config could not be read: callers then let the server's answer decide).
 * Read once per page; the setting only changes with a server restart.
 */
let cached: Promise<boolean | null> | null = null;

function load(): Promise<boolean | null> {
  cached ??= legalApi.config().then(
    (r) => (r.ok ? (r.value.email?.enabled ?? false) : null),
    () => null,
  );
  // A failed read is retried by the next screen that asks.
  void cached.then((v) => {
    if (v === null) cached = null;
  });
  return cached;
}

export function useMailEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((v) => {
      if (live) setEnabled(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
