import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  GUILD_ROLE_LABELS,
  GUILD_TOMBSTONE_LABELS,
  PLAYER_TEXT_RULES,
  guildChatDecision,
  validatePlayerText,
  type ReportTarget,
} from '@worldforge/game-core';
import type { ApiResult } from '../lib/api';
import { profileHref } from '../lib/route';
import { ReportDialog } from '../social/ReportDialog';
import { describeSanction } from '../social/api';
import { chatApi, describeChatFailure, useGuildChat, type ChatLine } from '../social/guildChat';
import './guild-chat.css';

/**
 * Guild chat (ticket 4.5): the hall's chronicle. The notice is a parchment nailed above it; the
 * chat is a ledger written oldest to newest, newest at the foot, with "earlier entries" at the
 * head. A removed or hidden line is a struck chatline (the server never sends its words). Report
 * opens the 4.1 dialog; strike and withdraw follow game-core's `guildChatDecision`, the table the
 * server enforces. A muted player reads the reason in place of the quill.
 */
export function GuildChat({ onClosed }: { onClosed: () => void }) {
  const { state, refresh, retry, loadOlder } = useGuildChat(onClosed);
  const [reporting, setReporting] = useState<ChatLine | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (state.kind === 'loading') {
    return (
      <section className="chronicle panel-iron" aria-labelledby="chronicle-title" aria-busy="true">
        <ChronicleHead />
        <p className="chronicle__empty">Unrolling the chronicle…</p>
      </section>
    );
  }
  if (state.kind === 'closed') return null;
  if (state.kind === 'error') {
    return (
      <section className="chronicle panel-iron" aria-labelledby="chronicle-title">
        <ChronicleHead />
        <p className="chronicle__empty" role="alert">
          {describeChatFailure(state.error)}{' '}
          <button type="button" className="btn btn--small" onClick={retry}>
            Try again
          </button>
        </p>
      </section>
    );
  }

  const { lines, notice, role, mute, hasOlder, stale } = state;
  const act: Act = async (key, run, done) => {
    setBusy(key);
    setFlash(null);
    const res = await run();
    setBusy(null);
    setFlash(
      res.ok ? { kind: 'ok', text: done } : { kind: 'error', text: describeChatFailure(res.error) },
    );
    refresh();
    return res.ok;
  };
  const canRemove = (l: ChatLine) =>
    guildChatDecision(role, 'delete', l.mine ? 'self' : (l.author?.role ?? 'none')) === 'allowed';

  return (
    <section className="chronicle panel-iron" aria-labelledby="chronicle-title">
      <ChronicleHead stale={stale} />
      <NoticeBoard
        notice={notice}
        canSet={guildChatDecision(role, 'setNotice') === 'allowed' && !mute}
        busy={busy}
        act={act}
        onReport={setReporting}
        canRemove={notice ? canRemove(notice) : false}
      />
      <Ledger
        lines={lines}
        hasOlder={hasOlder}
        loadOlder={loadOlder}
        busy={busy}
        act={act}
        canRemove={canRemove}
        onReport={setReporting}
      />
      {flash ? (
        <p
          className={`fellowship__notice fellowship__notice--${flash.kind}`}
          role={flash.kind === 'error' ? 'alert' : 'status'}
        >
          {flash.text}
        </p>
      ) : null}
      {mute ? (
        <div className="guild-strip guild-strip--crimson chronicle__muted" role="status">
          <p>{describeSanction(mute)}</p>
          <p className="guild-strip__reason">The wardens’ reason: “{mute.reason}”</p>
        </div>
      ) : (
        <Quill
          busy={busy === 'post'}
          onPost={(text) => act('post', () => chatApi.post(text), 'Written into the chronicle.')}
        />
      )}
      <ReportDialog
        open={reporting !== null}
        onClose={() => setReporting(null)}
        {...(reporting
          ? {
              target: {
                target: { kind: 'message', id: reporting.id } satisfies ReportTarget,
                label: `${reporting.kind === 'notice' ? 'the notice' : 'a line'} by ${authorName(reporting)}`,
              },
            }
          : {})}
      />
    </section>
  );
}

type Act = (key: string, run: () => Promise<ApiResult<unknown>>, done: string) => Promise<boolean>;

function ChronicleHead({ stale = false }: { stale?: boolean }) {
  return (
    <header className="chronicle__head">
      <h2 id="chronicle-title" className="rule-heading">
        The hall’s chronicle
      </h2>
      <p className="chronicle__fine">
        Only sworn members read it. {stale ? 'Could not refresh; showing the last entries.' : ''}
      </p>
    </header>
  );
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function when(iso: string): { short: string; full: string } {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return {
    short: today ? TIME.format(d) : `${DAY.format(d)} ${TIME.format(d)}`,
    full: d.toLocaleString('en-GB'),
  };
}

function authorName(l: ChatLine): string {
  if (!l.author) return 'a departed player';
  return l.author.displayName ?? 'a player whose name is hidden';
}

function Author({ line }: { line: ChatLine }) {
  const a = line.author;
  if (!a) return <span className="chatline__who chatline__who--gone">A departed player</span>;
  return (
    <span className="chatline__who">
      <a href={profileHref(a.handle)}>{a.displayName ?? 'Name withheld'}</a>
      {a.role && a.role !== 'member' ? (
        <span className={`chatline__rank chatline__rank--${a.role}`}>
          {GUILD_ROLE_LABELS[a.role]}
        </span>
      ) : null}
      {!a.role ? (
        <span className="chatline__rank chatline__rank--former">Former member</span>
      ) : null}
    </span>
  );
}

function LineActions({
  line,
  canRemove,
  busy,
  act,
  onReport,
}: {
  line: ChatLine;
  canRemove: boolean;
  busy: string | null;
  act: Act;
  onReport: (l: ChatLine) => void;
}) {
  if (line.tombstone) return null;
  return (
    <span className="chatline__acts">
      {!line.mine ? (
        <button type="button" className="chatline__act" onClick={() => onReport(line)}>
          Report
        </button>
      ) : null}
      {canRemove ? (
        <button
          type="button"
          className="chatline__act chatline__act--strike"
          disabled={busy === `remove:${line.id}`}
          onClick={() =>
            void act(
              `remove:${line.id}`,
              () => chatApi.remove(line.id),
              line.mine ? 'You withdrew your words.' : 'Struck from the record.',
            )
          }
        >
          {line.mine ? 'Withdraw' : 'Strike'}
        </button>
      ) : null}
    </span>
  );
}

function Tombstone({ line }: { line: ChatLine }) {
  return (
    <p className={`chatline__struck chatline__struck--${line.tombstone}`}>
      {GUILD_TOMBSTONE_LABELS[line.tombstone!]}
    </p>
  );
}

function NoticeBoard({
  notice,
  canSet,
  canRemove,
  busy,
  act,
  onReport,
}: {
  notice: ChatLine | null;
  canSet: boolean;
  canRemove: boolean;
  busy: string | null;
  act: Act;
  onReport: (l: ChatLine) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const id = useId();
  const check = text.trim() ? validatePlayerText('guildNotice', text) : null;
  const error = check && !check.ok ? check.message : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (error) return;
    if (await act('notice', () => chatApi.setNotice(text), 'The notice is nailed up.')) {
      setEditing(false);
      setText('');
    }
  };

  return (
    <div className="noticeboard">
      {notice ? (
        <article className="parchment" aria-label="Guild notice">
          <p className="parchment__label caps">Notice</p>
          {notice.tombstone ? (
            <Tombstone line={notice} />
          ) : (
            <p className="parchment__text">{notice.text}</p>
          )}
          <p className="parchment__by">
            <span aria-hidden="true">—</span>
            <Author line={notice} />
            <span aria-hidden="true">·</span>
            <time dateTime={notice.sentAt}>{when(notice.sentAt).short}</time>
            <LineActions
              line={notice}
              canRemove={canRemove}
              busy={busy}
              act={act}
              onReport={onReport}
            />
          </p>
        </article>
      ) : (
        <p className="noticeboard__empty">No notice is nailed to the hall door.</p>
      )}
      {canSet && !editing ? (
        <p className="noticeboard__tools">
          <button type="button" className="btn btn--small" onClick={() => setEditing(true)}>
            {notice ? 'Nail up a new notice' : 'Nail up a notice'}
          </button>
          {notice ? (
            <button
              type="button"
              className="btn btn--small"
              disabled={busy === 'notice'}
              onClick={() =>
                void act('notice', () => chatApi.setNotice(''), 'The notice is taken down.')
              }
            >
              Take it down
            </button>
          ) : null}
        </p>
      ) : null}
      {canSet && editing ? (
        <form className="noticeboard__form" onSubmit={submit}>
          <label className="field__label caps" htmlFor={id}>
            The notice (officers and the leader)
          </label>
          <div className="field__well">
            <textarea
              id={id}
              className="field__input chronicle__textarea"
              rows={3}
              value={text}
              maxLength={PLAYER_TEXT_RULES.guildNotice.max * 2}
              aria-describedby={`${id}-msg`}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <p id={`${id}-msg`} className={error ? 'field__error' : 'field__hint'}>
            {error ?? `Up to ${PLAYER_TEXT_RULES.guildNotice.max} letters. No links.`}
          </p>
          <span className="noticeboard__formacts">
            <button
              type="submit"
              className="btn btn--small btn--brass"
              disabled={!text.trim() || !!error || busy === 'notice'}
            >
              Nail it up
            </button>
            <button type="button" className="btn btn--small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        </form>
      ) : null}
    </div>
  );
}

function Ledger({
  lines,
  hasOlder,
  loadOlder,
  busy,
  act,
  canRemove,
  onReport,
}: {
  lines: ChatLine[];
  hasOlder: boolean;
  loadOlder: () => Promise<{ ok: boolean }>;
  busy: string | null;
  act: Act;
  canRemove: (l: ChatLine) => boolean;
  onReport: (l: ChatLine) => void;
}) {
  const log = useRef<HTMLOListElement>(null);
  const atFoot = useRef(true);
  const lastSeq = lines.at(-1)?.seq ?? 0;
  const [older, setOlder] = useState<'idle' | 'busy' | 'failed'>('idle');
  const keep = useRef<number | null>(null);

  // Keep the newest line in view when one arrives, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (atFoot.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastSeq, lines.length]);
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const onScroll = () => {
      atFoot.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const earlier = async () => {
    const el = log.current;
    if (el) keep.current = el.scrollHeight - el.scrollTop;
    setOlder('busy');
    const res = await loadOlder();
    setOlder(res.ok ? 'idle' : 'failed');
  };

  return (
    <div className="ledger">
      {hasOlder ? (
        <p className="ledger__older">
          <button
            type="button"
            className="btn btn--small"
            disabled={older === 'busy'}
            onClick={() => void earlier()}
          >
            {older === 'busy' ? 'Turning back the pages…' : 'Earlier entries'}
          </button>
          {older === 'failed' ? <span role="alert"> Could not load them. Try again.</span> : null}
        </p>
      ) : lines.length ? (
        <p className="ledger__older ledger__older--start">The chronicle begins here.</p>
      ) : null}
      {lines.length === 0 ? (
        <p className="chronicle__empty">The chronicle is blank. Be the first to write in it.</p>
      ) : null}
      <ol ref={log} className="ledger__log" aria-label="Guild chat" aria-live="polite" tabIndex={0}>
        {lines.map((l) => {
          const t = when(l.sentAt);
          return (
            <li
              key={l.seq}
              className={`chatline${l.mine ? ' chatline--mine' : ''}${l.kind === 'notice' ? ' chatline--notice' : ''}${l.tombstone ? ' chatline--struck' : ''}`}
            >
              <time className="chatline__time" dateTime={l.sentAt} title={t.full}>
                {t.short}
              </time>
              <div className="chatline__body">
                <p className="chatline__head">
                  <Author line={l} />
                  {l.kind === 'notice' ? (
                    <span className="chatline__tag caps">nailed a notice</span>
                  ) : null}
                  <LineActions
                    line={l}
                    canRemove={canRemove(l)}
                    busy={busy}
                    act={act}
                    onReport={onReport}
                  />
                </p>
                {l.tombstone ? <Tombstone line={l} /> : <p className="chatline__text">{l.text}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const MAX = PLAYER_TEXT_RULES.chatMessage.max;

function Quill({ busy, onPost }: { busy: boolean; onPost: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const id = useId();
  const check = text.trim() ? validatePlayerText('chatMessage', text) : null;
  const error = check && !check.ok && check.problem !== 'too_short' ? check.message : null;
  const length = check ? [...check.value].length : 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!check?.ok || busy) return;
    if (await onPost(check.value)) setText('');
  };
  return (
    <form className="quill" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={id}>
        Write to your guild
      </label>
      <div className="field__well quill__well">
        <input
          id={id}
          className="field__input"
          value={text}
          placeholder="Write to your guild…"
          autoComplete="off"
          maxLength={MAX * 2}
          aria-describedby={`${id}-msg`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn--brass" disabled={!check?.ok || busy}>
        {busy ? 'Writing…' : 'Write'}
      </button>
      <p id={`${id}-msg`} className={error ? 'field__error quill__msg' : 'field__hint quill__msg'}>
        {error ?? `${length} / ${MAX} · no links · officers may strike lines, wardens hide them`}
      </p>
    </form>
  );
}
