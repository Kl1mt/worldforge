import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { orderNotices, type Notice } from '../onboarding/notices';
import type { SeenStore } from '../onboarding/seen';
import { ReloadSlip } from '../onboarding/Notices';
import { createHealthPoll, type HealthPollDeps } from '../shell/healthPoll';
import { isChunkLoadError, watchChunkErrors } from './chunks';
import { ReloadBoundary, ReloadPanel } from './ReloadBoundary';
import {
  RELOAD_LATER_KEY,
  isReloadNoticeId,
  readReloadLater,
  reloadNotice,
  reloadOffer,
  writeReloadLater,
} from './update';

const base = { bundled: '0.5.3', later: null, guideActive: false, chunkFailed: false };

function memoryStore(): SeenStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

describe('the reload offer (ticket F.4)', () => {
  it('shows only when the server runs a strictly newer version', () => {
    expect(reloadOffer({ ...base, serverVersion: '0.5.4' })).toEqual({
      show: true,
      version: '0.5.4',
      reason: 'newer',
    });
    expect(reloadOffer({ ...base, serverVersion: '0.6.0' })).toMatchObject({ show: true });
    expect(reloadOffer({ ...base, serverVersion: '0.5.10', bundled: '0.5.9' })).toMatchObject({
      show: true,
    });
  });

  it('never prompts for an equal, older, missing or malformed version', () => {
    for (const serverVersion of [null, '0.5.3', '0.5.2', '0.4.9', '', 'v0.5.4', '0.5', 'soon']) {
      expect(reloadOffer({ ...base, serverVersion }), String(serverVersion)).toEqual({
        show: false,
      });
    }
  });

  it('stays quiet for the version the player said "Later" to, and asks again for the next', () => {
    expect(reloadOffer({ ...base, serverVersion: '0.5.4', later: '0.5.4' })).toEqual({
      show: false,
    });
    expect(reloadOffer({ ...base, serverVersion: '0.5.5', later: '0.5.4' })).toMatchObject({
      show: true,
      version: '0.5.5',
    });
  });

  it('waits for the first-steps guide', () => {
    expect(reloadOffer({ ...base, serverVersion: '0.5.4', guideActive: true })).toEqual({
      show: false,
    });
  });

  it('always offers a reload after a failed load, with the version when one is known', () => {
    expect(reloadOffer({ ...base, serverVersion: null, chunkFailed: true })).toEqual({
      show: true,
      version: null,
      reason: 'chunk',
    });
    expect(
      reloadOffer({
        ...base,
        serverVersion: '0.5.4',
        later: '0.5.4',
        guideActive: true,
        chunkFailed: true,
      }),
    ).toEqual({ show: true, version: '0.5.4', reason: 'chunk' });
  });

  it('keeps "Later" per version in the browser store', () => {
    const store = memoryStore();
    expect(readReloadLater(store)).toBeNull();
    writeReloadLater(store, '0.5.4');
    expect(store.data.get(RELOAD_LATER_KEY)).toBe('0.5.4');
    const later = readReloadLater(store);
    expect(reloadOffer({ ...base, serverVersion: '0.5.4', later })).toEqual({ show: false });
    expect(reloadOffer({ ...base, serverVersion: '0.5.5', later })).toMatchObject({ show: true });
  });
});

describe('the reload slip', () => {
  it('names the new version in plain words', () => {
    const n = reloadNotice({ version: '0.5.4', reason: 'newer' });
    expect(n).toMatchObject({ id: 'reload:0.5.4', kind: 'reload', title: 'Graumark has changed' });
    expect(n.text).toBe('v0.5.4 is out. Reload to join it.');
    expect(isReloadNoticeId(n.id)).toBe(true);
    expect(isReloadNoticeId('release:0.5.4')).toBe(false);
    expect(reloadNotice({ version: null, reason: 'chunk' }).id).toBe('reload:unknown');
    expect(reloadNotice({ version: null, reason: 'chunk' }).text).toMatch(/did not load/);
  });

  it('gives way to every other notice (least important, so phones show the others first)', () => {
    const level: Notice = { id: 'level:h:2', kind: 'level', title: 'Level 2', text: '' };
    const release: Notice = { id: 'release:0.5.3', kind: 'release', title: 'New', text: '' };
    const reload = reloadNotice({ version: '0.5.4', reason: 'newer' });
    expect(orderNotices([reload, level, release]).map((n) => n.kind)).toEqual([
      'reload',
      'release',
      'level',
    ]);
  });

  it('offers Reload and Later and no dismiss ×', () => {
    const html = renderToStaticMarkup(
      <ReloadSlip
        notice={reloadNotice({ version: '0.5.4', reason: 'newer' })}
        later={() => {}}
        reload={() => {}}
      />,
    );
    expect(html).toContain('Word from the gate');
    expect(html).toContain('v0.5.4 is out. Reload to join it.');
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).toMatch(/<button[^>]*>Later<\/button>/);
    expect(html).not.toContain('notice__close');
    expect(html).not.toContain('autofocus');
  });
});

/** A hand-driven clock and timer queue: no wall-clock waits. */
function harness(answers: Array<() => Promise<Response>>) {
  let now = 1_000_000;
  let hidden = false;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const visible = new Set<() => void>();
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const answer = answers.shift();
    if (!answer) throw new Error('no more answers');
    return answer();
  }) as unknown as typeof fetch;
  const deps: HealthPollDeps = {
    fetchImpl,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    hidden: () => hidden,
    onVisible: (fn) => {
      visible.add(fn);
      return () => visible.delete(fn);
    },
  };
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    deps,
    calls,
    timers,
    flush,
    /** Moves the clock forward and runs the timers that came due. */
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    setHidden(h: boolean) {
      hidden = h;
      if (!h) for (const fn of [...visible]) fn();
    },
  };
}

const ok = (version?: string) => async () =>
  Response.json({ status: 'ok', uptimeSeconds: 1, db: 'up', ...(version ? { version } : {}) });

describe('the shared health poll', () => {
  it('checks on start, then every 5 minutes, and carries the server version', async () => {
    const h = harness([ok('0.5.3'), ok('0.5.4')]);
    const poll = createHealthPoll(h.deps);
    const seen: Array<string | null> = [];
    const stop = poll.subscribe(() => seen.push(poll.getSnapshot().serverVersion));
    expect(poll.getSnapshot().health).toEqual({ kind: 'loading' });
    await h.flush();
    expect(h.calls).toEqual(['/api/health']);
    expect(poll.getSnapshot().health).toMatchObject({ kind: 'ok', version: '0.5.3' });

    h.advance(5 * 60_000 - 1);
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(seen).toEqual(['0.5.3', '0.5.4']);
    stop();
    expect(h.timers).toHaveLength(0);
  });

  it('keeps the last known version through an outage', async () => {
    const h = harness([ok('0.5.4'), async () => new Response('', { status: 502 })]);
    const poll = createHealthPoll(h.deps);
    const stop = poll.subscribe(() => {});
    await h.flush();
    h.advance(5 * 60_000);
    await h.flush();
    expect(poll.getSnapshot()).toEqual({
      health: { kind: 'error', message: 'Server responded 502' },
      serverVersion: '0.5.4',
    });
    stop();
  });

  it('skips checks while the tab is hidden and checks once when it comes back', async () => {
    const h = harness([ok('0.5.3'), ok('0.5.4')]);
    const poll = createHealthPoll(h.deps);
    const stop = poll.subscribe(() => {});
    await h.flush();
    h.setHidden(true);
    h.advance(5 * 60_000);
    h.advance(5 * 60_000);
    expect(h.calls).toHaveLength(1);
    h.setHidden(false);
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(poll.getSnapshot().serverVersion).toBe('0.5.4');
    stop();
  });

  it('does not re-check a tab that comes back within a minute of the last check', async () => {
    const h = harness([ok('0.5.3'), ok('0.5.4')]);
    const poll = createHealthPoll(h.deps);
    const stop = poll.subscribe(() => {});
    await h.flush();
    h.advance(59_999);
    poll.refresh();
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    poll.refresh();
    poll.refresh();
    await h.flush();
    expect(h.calls).toHaveLength(2);
    stop();
  });

  it('stops polling (and aborts a running check) when nothing listens', async () => {
    let signal: AbortSignal | undefined;
    const h = harness([]);
    h.deps.fetchImpl = ((_: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }) as unknown as typeof fetch;
    const poll = createHealthPoll(h.deps);
    const stop = poll.subscribe(() => {});
    stop();
    expect(signal?.aborted).toBe(true);
    expect(h.timers).toHaveLength(0);
  });

  it('feeds the offer: newer shows, equal does not', async () => {
    for (const [server, show] of [
      ['0.5.4', true],
      ['0.5.3', false],
      ['0.5.2', false],
    ] as const) {
      const h = harness([ok(server)]);
      const poll = createHealthPoll(h.deps);
      const stop = poll.subscribe(() => {});
      await h.flush();
      expect(reloadOffer({ ...base, serverVersion: poll.getSnapshot().serverVersion }).show).toBe(
        show,
      );
      stop();
    }
  });
});

const chromium = new TypeError(
  'Failed to fetch dynamically imported module: https://play.example/assets/BoardsScreen-1a2b3c.js',
);

describe('a failed chunk load', () => {
  it('is recognised in every browser’s wording', () => {
    expect(isChunkLoadError(chromium)).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('leads to the reload offer (Vite’s preload error or an unhandled rejection)', () => {
    const target = new EventTarget();
    const onFail = vi.fn();
    const stop = watchChunkErrors(target, onFail);
    target.dispatchEvent(new Event('vite:preloadError'));
    expect(onFail).toHaveBeenCalledTimes(1);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: chromium }));
    expect(onFail).toHaveBeenCalledTimes(2);
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('unrelated') }),
    );
    expect(onFail).toHaveBeenCalledTimes(2);
    stop();
    target.dispatchEvent(new Event('vite:preloadError'));
    expect(onFail).toHaveBeenCalledTimes(2);
    expect(reloadOffer({ ...base, serverVersion: null, chunkFailed: true }).show).toBe(true);
  });

  it('shows an in-world reload panel instead of a blank screen', async () => {
    // A lazy screen whose file is gone rejects with the browser's chunk error.
    const failedImport = Promise.reject(chromium);
    const err = await failedImport.catch((e: unknown) => e);
    expect(ReloadBoundary.getDerivedStateFromError(err)).toEqual({ failure: 'chunk' });
    expect(ReloadBoundary.getDerivedStateFromError(new Error('boom'))).toEqual({
      failure: 'other',
    });

    const boundary = new ReloadBoundary({ children: <p>screen</p>, town: true });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>screen</p>');
    boundary.state = ReloadBoundary.getDerivedStateFromError(err);
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Graumark has changed');
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).toContain('href="#/hub"');

    const other = renderToStaticMarkup(<ReloadPanel failure="other" />);
    expect(other).toContain('This screen stumbled');
    expect(other).not.toContain('Back to town');
  });
});
