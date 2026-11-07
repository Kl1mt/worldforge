import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GAME_VERSION, PATCH_NOTES, type PatchNote } from '@worldforge/game-core';
import { orderNotices, type Notice } from '../onboarding/notices';
import { parseRoute, routeHref } from '../lib/route';
import { NotesScreen } from './NotesScreen';
import { formatDate } from './format';
import {
  isNewRelease,
  notesSeenKey,
  notesUnread,
  releaseNotice,
  releaseNoticeId,
  versionLabel,
} from './unread';

describe('the notes route (ticket F.3)', () => {
  it('parses #/notes and round-trips', () => {
    expect(parseRoute('#/notes')).toBe('notes');
    expect(parseRoute(routeHref('notes'))).toBe('notes');
    expect(releaseNotice().href).toBe(routeHref('notes'));
  });
});

describe('the unread marker', () => {
  it('starts a brand-new player (guide running, nothing stored) at the current version, silently', () => {
    expect(notesUnread(null, true, '0.5.2')).toEqual({
      unread: false,
      announce: false,
      baseline: true,
    });
  });

  it('tells a player who never read the notes on this device, once the guide is done', () => {
    expect(notesUnread(null, false, '0.5.2')).toEqual({
      unread: true,
      announce: true,
      baseline: false,
    });
  });

  it('marks a newer release unread, but keeps the slip back while the guide runs', () => {
    expect(notesUnread('0.5.1', false, '0.5.2')).toMatchObject({ unread: true, announce: true });
    expect(notesUnread('0.5.1', true, '0.5.2')).toMatchObject({ unread: true, announce: false });
    expect(notesUnread('0.4.0', false, '0.10.0')).toMatchObject({ unread: true });
  });

  it('clears once the current version (or a later one) was read', () => {
    for (const seen of ['0.5.2', '0.6.0']) {
      expect(notesUnread(seen, false, '0.5.2')).toEqual({
        unread: false,
        announce: false,
        baseline: false,
      });
    }
  });

  it('treats a garbled stored value as never read', () => {
    expect(notesUnread('nonsense', false, '0.5.2')).toMatchObject({ unread: true });
  });

  it('keeps the stored version per account', () => {
    expect(notesSeenKey('a1')).toBe('wf.seen.notes.a1');
    expect(notesSeenKey('a1')).not.toBe(notesSeenKey('a2'));
  });

  it('marks the releases newer than what was read before', () => {
    expect(isNewRelease('0.5.2', '0.5.0', '0.5.2')).toBe(true);
    expect(isNewRelease('0.5.1', '0.5.0', '0.5.2')).toBe(true);
    expect(isNewRelease('0.5.0', '0.5.0', '0.5.2')).toBe(false);
    expect(isNewRelease('0.5.2', null, '0.5.2')).toBe(true);
    expect(isNewRelease('0.5.1', null, '0.5.2')).toBe(false);
  });

  it('gives way to every progress notice on phones (rendered first, never last)', () => {
    const n = (id: string, kind: Notice['kind']): Notice => ({ id, kind, title: id, text: '' });
    const order = orderNotices([releaseNotice('0.5.2'), n('l', 'level'), n('w', 'world')]);
    expect(order.map((x) => x.id)).toEqual([releaseNoticeId('0.5.2'), 'l', 'w']);
    expect(releaseNotice('0.5.2').title).toBe('New in v0.5.2');
  });
});

describe('the notes screen', () => {
  it('shows every release newest first with its version, date and grouped entries', () => {
    const html = renderToStaticMarkup(<NotesScreen seenBefore={GAME_VERSION} />);
    let last = -1;
    for (const note of PATCH_NOTES) {
      const at = html.indexOf(`>${versionLabel(note.version)}<`);
      expect(at, note.version).toBeGreaterThan(last);
      last = at;
      expect(html).toContain(formatDate(note.date));
    }
    expect(html).toContain('>New<');
    expect(html).toContain('>Fixed<');
    // Read already: nothing carries the "New to you" tag.
    expect(html).not.toContain('New<span class="visually-hidden"> to you');
  });

  it('marks what is new since the last read, and opens it', () => {
    const notes: PatchNote[] = [
      { version: '0.2.0', date: '2026-01-02', title: 'Two', new: ['b'] },
      { version: '0.1.1', date: '2026-01-01', title: 'One and a bit', fixed: ['a2'] },
      { version: '0.1.0', date: '2026-01-01', title: 'One', new: ['a'] },
    ];
    const html = renderToStaticMarkup(<NotesScreen seenBefore="0.1.0" notes={notes} />);
    expect(html.match(/proclaim__sheet--new/g)).toHaveLength(2);
    expect(html.match(/<details class="proclaim__fold" open="">/g)).toHaveLength(2);
  });

  it('has an empty state', () => {
    const html = renderToStaticMarkup(<NotesScreen seenBefore={null} notes={[]} />);
    expect(html).toContain('nothing to read out yet');
  });

  it('formats dates as calendar days', () => {
    expect(formatDate('2026-11-07')).toBe('7 November 2026');
    expect(formatDate('bad')).toBe('bad');
  });
});
