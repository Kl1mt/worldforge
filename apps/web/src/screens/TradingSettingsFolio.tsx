import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  TRADE_CATEGORIES,
  TRADE_KINDS,
  TRADING_LAUNCH_ORDER,
  TRADING_LIMITS,
  TRADING_LIMITS_WHEN_LOWERED,
  TRADING_LIMIT_IDS,
  TRADING_SWITCHES,
  diffTradingSettings,
  readSwitch,
  validateTradingSettings,
  type TradingLimitId,
  type TradingSettings,
  type TradingSettingsChange,
  type TradingSwitchPath,
} from '@worldforge/game-core';
import { adminApi, describeAdminFailure, type TradingSettingsView } from '../admin/api';
import type { ApiFailure } from '../lib/api';
import { formatWhen } from '../social/api';
import './trading-settings.css';

/**
 * Ticket T.2: the "Trading settings" folio of the admin panel (docs/TRADING.md "Admin switches").
 * The tariff board of the keep: every switch is an iron lever on a ruled ledger, with what it
 * controls and what switching it off does to players; the limits are a column of tally boxes with
 * their hard maxima stamped beside them; the launch order and the change history hang at the side.
 * Admins edit (nothing is saved until "Save changes"); moderators see the same board read-only.
 */

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; view: TradingSettingsView }
  | { kind: 'error'; error: ApiFailure };

const GROUPS: { id: string; title: string; lede: string; paths: TradingSwitchPath[] }[] = [
  {
    id: 'master',
    title: 'The master switch',
    lede: 'While this is off, players can’t trade at all, whatever the switches below say.',
    paths: ['trading'],
  },
  {
    id: 'trade',
    title: 'What an offer may hold',
    lede: 'Each kind of value has its own switch.',
    paths: TRADE_KINDS.map((k) => `trade.${k}` as const),
  },
  {
    id: 'tradeable',
    title: 'Which items',
    lede: 'Only fresh items (never worn, never forged) from farming, crypt chambers and crafting. These matter once Trading and Trade: items are on.',
    paths: TRADE_CATEGORIES.map((c) => `tradeable.${c}` as const),
  },
  {
    id: 'shelf',
    title: 'The account shelf',
    lede: 'Moving value between one player’s own heroes. No caps; every move is audited.',
    paths: TRADE_KINDS.map((k) => `shelf.${k}` as const),
  },
];

const nf = (n: number) => n.toLocaleString('en-GB');

function labelOf(path: string): string {
  if (path.startsWith('limits.')) {
    return TRADING_LIMITS[path.slice(7) as TradingLimitId]?.label ?? path;
  }
  return TRADING_SWITCHES[path as TradingSwitchPath]?.label ?? path;
}

function valueOf(v: boolean | number): string {
  return typeof v === 'boolean' ? (v ? 'on' : 'off') : nf(v);
}

function setSwitch(s: TradingSettings, path: TradingSwitchPath, on: boolean): TradingSettings {
  const next: TradingSettings = JSON.parse(JSON.stringify(s)) as TradingSettings;
  if (path === 'trading') next.trading = on;
  else {
    const [group, key] = path.split('.') as ['trade' | 'tradeable' | 'shelf', string];
    (next[group] as Record<string, boolean>)[key] = on;
  }
  return next;
}

/** What players can trade right now, in one line. */
function openSummary(s: TradingSettings): string {
  if (!s.trading) return 'Trading is closed: nothing can be traded.';
  const kinds = TRADE_KINDS.filter((k) => s.trade[k]);
  if (kinds.length === 0) return 'Trading is open, but offers may hold nothing yet.';
  const items = s.trade.items
    ? TRADE_CATEGORIES.filter((c) => s.tradeable[c]).map((c) =>
        TRADING_SWITCHES[`tradeable.${c}`].label.replace('Tradeable: ', ''),
      )
    : [];
  const parts = kinds.map((k) =>
    k === 'items' ? `items (${items.length ? items.join(', ') : 'no category on'})` : k,
  );
  return `Players can trade ${parts.join(', ')}.`;
}

export function TradingSettingsFolio({ readOnly = false }: { readOnly?: boolean }) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<TradingSettings | null>(null);
  const [limitText, setLimitText] = useState<Partial<Record<TradingLimitId, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; conflict?: boolean } | null>(
    null,
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [olderLoading, setOlderLoading] = useState(false);
  const [older, setOlder] = useState<{
    entries: TradingSettingsView['history'];
    next: string | null;
  } | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    adminApi.tradingSettings(controller.signal).then(
      (res) => {
        setState(res.ok ? { kind: 'ready', view: res.value } : { kind: 'error', error: res.error });
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setDraft(null);
    setLimitText({});
    setFields({});
    setOlder(null);
    setAttempt((n) => n + 1);
  }, []);

  const view = state.kind === 'ready' ? state.view : null;
  const editable = !readOnly && view?.canEdit === true;
  const shown = draft ?? view?.settings ?? null;
  const pending: TradingSettingsChange[] =
    view && draft ? diffTradingSettings(view.settings, draft) : [];
  const textErrors = Object.fromEntries(
    TRADING_LIMIT_IDS.flatMap((id) => {
      const t = limitText[id];
      if (t === undefined) return [];
      return /^\d{1,9}$/.test(t.trim()) ? [] : [[`limits.${id}`, 'Must be a whole number.']];
    }),
  ) as Record<string, string>;
  const localCheck = draft ? validateTradingSettings(draft) : null;
  const errors: Record<string, string> = {
    ...(localCheck && !localCheck.ok ? localCheck.fields : {}),
    ...textErrors,
    ...fields,
  };
  const hasErrors = Object.keys(errors).length > 0;

  const edit = (next: TradingSettings) => {
    setDraft(next);
    setMessage(null);
    setFields({});
    key.current = null;
  };

  const save = async () => {
    if (!view || !draft || hasErrors || pending.length === 0) return;
    setSaving(true);
    setMessage(null);
    // One key per change set: a retry after a dropped connection replays instead of saving twice.
    key.current ??= crypto.randomUUID();
    const res = await adminApi.saveTradingSettings(view.version, draft, key.current);
    setSaving(false);
    if (!res.ok) {
      if (res.error.status !== 0) key.current = null;
      const f = Object.fromEntries(
        Object.entries(res.error.fields).map(([k, v]) => [k.replace(/^settings\./, ''), v]),
      );
      setFields(f);
      setMessage({
        ok: false,
        text: describeAdminFailure(res.error),
        conflict: res.error.code === 'settings_conflict',
      });
      return;
    }
    key.current = null;
    setState({ kind: 'ready', view: res.value });
    setDraft(null);
    setLimitText({});
    setOlder(null);
    setMessage({
      ok: true,
      text: res.value.changed
        ? `Saved (version ${res.value.version}). It is live on this server now and everywhere within a minute.`
        : 'Nothing had changed.',
    });
  };

  const loadOlder = async () => {
    const cursor = older ? older.next : view?.nextCursor;
    if (!cursor) return;
    setOlderLoading(true);
    const res = await adminApi.tradingSettings(undefined, cursor);
    setOlderLoading(false);
    if (res.ok) {
      setOlder((o) => ({
        entries: [...(o?.entries ?? []), ...res.value.history],
        next: res.value.nextCursor,
      }));
    } else {
      setMessage({ ok: false, text: describeAdminFailure(res.error) });
    }
  };

  return (
    <div className="tset">
      <div className="tset__main">
        <div className="strong__bar">
          <h2 className="rule-heading">Trading settings</h2>
          <button
            type="button"
            className="btn btn--small"
            onClick={reload}
            disabled={state.kind === 'loading' || saving}
          >
            Reload
          </button>
        </div>
        {state.kind === 'loading' ? (
          <p className="strong__wait" role="status">
            Reading the tariff board…
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <div className="gate__alert strong__alert" role="alert">
            <p>The trading settings could not be read. {describeAdminFailure(state.error)}</p>
            <button type="button" className="btn btn--small" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
        {view && shown ? (
          <>
            <div className={`tset__state${shown.trading ? ' tset__state--open' : ''}`}>
              <p className="caps">{readOnly || !view.canEdit ? 'Read-only' : 'Now in force'}</p>
              <p className="tset__summary">{openSummary(view.settings)}</p>
              <p className="tset__meta">
                {view.version === 0
                  ? 'Never changed: these are the launch defaults.'
                  : `Version ${view.version}, saved ${view.updatedAt ? formatWhen(view.updatedAt) : ''}${view.updatedBy ? ` by ${view.updatedBy.displayName}` : ''}.`}
              </p>
            </div>

            {GROUPS.map((g) => (
              <SwitchGroup
                key={g.id}
                title={g.title}
                lede={g.lede}
                paths={g.paths}
                shown={shown}
                stored={view.settings}
                defaults={view.defaults}
                editable={editable}
                disabled={saving}
                dimmed={g.id !== 'master' && g.id !== 'shelf' && !shown.trading}
                onChange={(path, on) => edit(setSwitch(shown, path, on))}
              />
            ))}

            <section className="tset__group panel-ledger" aria-labelledby="tset-limits">
              <h3 id="tset-limits" className="tset__group-title display">
                Weekly limits
              </h3>
              <p className="tset__lede">
                Per account, over a rolling 7 days, given and received counted separately. Every
                number has a hard maximum in the code. {TRADING_LIMITS_WHEN_LOWERED}
              </p>
              <ol className="tset__limits">
                {TRADING_LIMIT_IDS.map((id) => (
                  <LimitRow
                    key={id}
                    id={id}
                    value={shown.limits[id]}
                    text={limitText[id]}
                    stored={view.settings.limits[id]}
                    error={errors[`limits.${id}`]}
                    editable={editable}
                    disabled={saving}
                    onText={(t) => {
                      setLimitText((m) => ({ ...m, [id]: t }));
                      const n = /^\d{1,9}$/.test(t.trim()) ? Number(t.trim()) : NaN;
                      const next = JSON.parse(JSON.stringify(shown)) as TradingSettings;
                      next.limits[id] = Number.isNaN(n) ? shown.limits[id] : n;
                      edit(next);
                    }}
                  />
                ))}
              </ol>
            </section>

            {editable ? (
              <div className="tset__savebar panel-iron" aria-live="polite">
                <p className="tset__pending">
                  {pending.length === 0
                    ? 'No unsaved changes.'
                    : `${pending.length} unsaved change${pending.length === 1 ? '' : 's'}: ${pending
                        .map((c) => `${labelOf(c.path)} ${valueOf(c.old)} → ${valueOf(c.new)}`)
                        .join('; ')}.`}
                </p>
                <div className="tset__actions">
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={saving || (pending.length === 0 && !hasErrors)}
                    onClick={() => {
                      setDraft(null);
                      setLimitText({});
                      setFields({});
                      setMessage(null);
                    }}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn--brass"
                    disabled={saving || pending.length === 0 || hasErrors}
                    onClick={() => void save()}
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {message ? (
          <div
            className={message.ok ? 'strong__note tset__ok' : 'gate__alert strong__alert'}
            role={message.ok ? 'status' : 'alert'}
          >
            <p>{message.text}</p>
            {message.conflict ? (
              <button type="button" className="btn btn--small" onClick={reload}>
                Reload the settings
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <aside className="tset__side">
        <section className="tset__order panel-iron" aria-labelledby="tset-order">
          <p className="caps">Guidance</p>
          <h3 id="tset-order" className="display">
            Suggested launch order
          </h3>
          <ol>
            {TRADING_LAUNCH_ORDER.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="dossier__dim">
            Switching something off never traps what a player owns. Changes reach every server
            within a minute, without a deploy.
          </p>
        </section>
        <section className="tset__history panel-ledger" aria-labelledby="tset-history">
          <h3 id="tset-history" className="tset__group-title display">
            Change history
          </h3>
          {state.kind === 'loading' ? (
            <p className="strong__wait">…</p>
          ) : view && view.history.length === 0 ? (
            <p className="tset__empty">
              No change yet. Every save is listed here with who made it, when, and each old and new
              value.
            </p>
          ) : view ? (
            <>
              <ol className="tset__log">
                {[...view.history, ...(older?.entries ?? [])].map((h) => (
                  <li key={h.id} className="tset__entry">
                    <p className="tset__entry-head">
                      <span className="tset__entry-version">v{h.version}</span>{' '}
                      {h.by ? h.by.displayName : 'A removed account'} ·{' '}
                      <time dateTime={h.at}>{formatWhen(h.at)}</time>
                    </p>
                    <ul className="tset__entry-changes">
                      {h.changes.map((c) => (
                        <li key={c.path}>
                          {labelOf(c.path)}: <s>{valueOf(c.old)}</s> → <b>{valueOf(c.new)}</b>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              {(older ? older.next : view.nextCursor) ? (
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => void loadOlder()}
                  disabled={olderLoading}
                >
                  {olderLoading ? 'Reading…' : 'Older changes'}
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      </aside>
    </div>
  );
}

function SwitchGroup({
  title,
  lede,
  paths,
  shown,
  stored,
  defaults,
  editable,
  disabled,
  dimmed,
  onChange,
}: {
  title: string;
  lede: string;
  paths: TradingSwitchPath[];
  shown: TradingSettings;
  stored: TradingSettings;
  defaults: TradingSettings;
  editable: boolean;
  disabled: boolean;
  dimmed: boolean;
  onChange: (path: TradingSwitchPath, on: boolean) => void;
}) {
  const ids = useId();
  return (
    <section
      className={`tset__group panel-ledger${dimmed ? ' tset__group--dim' : ''}`}
      aria-labelledby={`${ids}-h`}
    >
      <h3 id={`${ids}-h`} className="tset__group-title display">
        {title}
      </h3>
      <p className="tset__lede">{lede}</p>
      <ul className="tset__switches">
        {paths.map((p) => {
          const info = TRADING_SWITCHES[p];
          const on = readSwitch(shown, p);
          const changed = on !== readSwitch(stored, p);
          return (
            <li key={p} className={`tset__switch${changed ? ' tset__switch--changed' : ''}`}>
              <div className="tset__switch-text">
                <p className="tset__switch-name" id={`${ids}-${p}`}>
                  {info.label}
                  {readSwitch(defaults, p) === on ? null : (
                    <span className="tset__badge">
                      default {readSwitch(defaults, p) ? 'on' : 'off'}
                    </span>
                  )}
                </p>
                <p className="tset__switch-controls">{info.controls}</p>
                <p className="tset__switch-off">
                  <span className="caps">When switched off</span> {info.whenOff}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-labelledby={`${ids}-${p}`}
                className={`tset__lever${on ? ' tset__lever--on' : ''}`}
                disabled={!editable || disabled}
                onClick={() => onChange(p, !on)}
              >
                <span className="tset__lever-track" aria-hidden="true">
                  <span className="tset__lever-knob" />
                </span>
                <span className="tset__lever-word">{on ? 'On' : 'Off'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LimitRow({
  id,
  value,
  text,
  stored,
  error,
  editable,
  disabled,
  onText,
}: {
  id: TradingLimitId;
  value: number;
  text: string | undefined;
  stored: number;
  error: string | undefined;
  editable: boolean;
  disabled: boolean;
  onText: (text: string) => void;
}) {
  const info = TRADING_LIMITS[id];
  const ids = useId();
  const changed = value !== stored;
  return (
    <li className={`tset__limit${changed ? ' tset__limit--changed' : ''}`}>
      <div className="tset__limit-text">
        <label className="tset__limit-name" htmlFor={`${ids}-in`}>
          {info.label}
        </label>
        <p className="tset__limit-explains">{info.explains}</p>
      </div>
      <div className="tset__limit-box">
        {editable ? (
          <input
            id={`${ids}-in`}
            className="field__input tset__limit-input"
            inputMode="numeric"
            value={text ?? String(value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${ids}-max${error ? ` ${ids}-err` : ''}`}
            disabled={disabled}
            onChange={(e) => onText(e.target.value)}
          />
        ) : (
          <output id={`${ids}-in`} className="tset__limit-value">
            {nf(value)}
          </output>
        )}
        <span className="tset__limit-max" id={`${ids}-max`}>
          {info.unit} · max {nf(info.max)} · default {nf(info.default)}
        </span>
        {error ? (
          <span className="tset__limit-error" id={`${ids}-err`} role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </li>
  );
}
