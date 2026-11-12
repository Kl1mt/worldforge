import { useId, useState } from 'react';
import {
  LOOT_FILTER_CODE_MAX_LENGTH,
  LOOT_FILTER_PRESET_LIMIT,
  LOOT_FILTER_PRESET_NAME_MAX,
  decodeLootFilterCode,
  encodeLootFilterCode,
  isLootFilterActive,
  lootFilterHandles,
  normalisePresetName,
  type LootFilterCodeError,
  type LootFilterRules,
} from '@worldforge/game-core';
import { describeGameFailure, lootFilterApi, type LootFilterState } from '../game/api';
import { describeRules } from '../game/lootFilter';
import type { ItemView } from '../game/items';

type Notice = { kind: 'ok' | 'error'; text: string };

const CODE_ERROR: Record<LootFilterCodeError, string> = {
  malformed: 'That is not a loot-filter code. Copy the whole code, from “wf” to its end.',
  version: 'That code comes from another version of the filter and cannot be read here.',
  checksum: 'That code was changed or mistyped. Copy it again from where it was shared.',
  invalid: 'That code names something this filter does not know. Nothing was changed.',
};

/** The reason the server gave for an unreadable code, or its general message. */
function codeFailure(error: { code: string; details?: unknown }): string {
  const reason = (error.details as { reason?: LootFilterCodeError } | undefined)?.reason;
  return error.code === 'invalid_filter_code' && reason && CODE_ERROR[reason]
    ? CODE_ERROR[reason]
    : describeGameFailure(error);
}

/**
 * Ticket 8.5 (docs/LOOT.md "Presets and share codes"): up to five named presets per hero, and
 * share codes. A code is read twice: here for a quick check, and by the server for the preview
 * and on use (the server never trusts this reading).
 */
export function LootFilterPresets({
  heroId,
  state,
  draft,
  pack,
  onChange,
}: {
  heroId: string;
  state: LootFilterState;
  /** The rules on screen (saved as a preset as they stand). */
  draft: LootFilterRules;
  pack: readonly ItemView[];
  /** The server's new state after a change (the filter in force may have changed). */
  onChange: (next: LootFilterState, message: string) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [name, setName] = useState('');
  const [overwrite, setOverwrite] = useState(0);
  const [renaming, setRenaming] = useState<{ slot: number; name: string } | null>(null);
  const [sharing, setSharing] = useState<number | 'current' | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<LootFilterRules | null | 'none'>('none');
  const presets = state.presets;
  const full = presets.length >= LOOT_FILTER_PRESET_LIMIT;

  const run = async (
    key: string,
    call: () => Promise<
      | { ok: true; value: LootFilterState }
      | { ok: false; error: { code: string; details?: unknown } }
    >,
    message: string,
  ): Promise<boolean> => {
    setBusy(key);
    setNotice(null);
    const res = await call();
    setBusy(null);
    if (res.ok) {
      onChange(res.value, message);
      setNotice({ kind: 'ok', text: message });
      return true;
    }
    setNotice({ kind: 'error', text: codeFailure(res.error) });
    return false;
  };

  const saveDraft = async () => {
    const clean = normalisePresetName(name);
    if (!clean) {
      setNotice({
        kind: 'error',
        text: `Name the preset (1–${LOOT_FILTER_PRESET_NAME_MAX} characters).`,
      });
      return;
    }
    const slot = full ? overwrite : presets.length;
    const rules = isLootFilterActive(draft) ? draft : null;
    if (
      await run(
        'save',
        () => lootFilterApi.savePreset(heroId, { slot, name: clean, rules }),
        full ? `“${clean}” replaced the preset in slot ${slot + 1}.` : `Saved as “${clean}”.`,
      )
    ) {
      setName('');
    }
  };

  const readCode = async () => {
    setCopied(false);
    setPreview('none');
    // A quick local check first: a mistyped code needs no request.
    const local = decodeLootFilterCode(code);
    if (!local.ok) {
      setNotice({ kind: 'error', text: CODE_ERROR[local.error] });
      return;
    }
    setBusy('read');
    setNotice(null);
    const res = await lootFilterApi.decode(heroId, code.trim());
    setBusy(null);
    if (res.ok) setPreview(res.value.active ? res.value.rules : null);
    else setNotice({ kind: 'error', text: codeFailure(res.error) });
  };

  const shareCode =
    sharing === null
      ? null
      : encodeLootFilterCode(
          sharing === 'current' ? state.rules : (presets[sharing]?.rules ?? null),
        );
  const handled = (rules: LootFilterRules | null) =>
    rules && isLootFilterActive(rules)
      ? pack.filter((i) => lootFilterHandles(i.filterKey, rules)).length
      : 0;

  return (
    <section className="lfp" aria-labelledby={`${id}-title`}>
      <header className="lfp__head">
        <h3 id={`${id}-title`} className="caps lfp__title">
          Presets
        </h3>
        <p className="lfp__note">
          {presets.length} of {LOOT_FILTER_PRESET_LIMIT} kept for this hero. Using one settles your
          hero first, like saving the filter.
        </p>
      </header>

      {presets.length === 0 ? (
        <p className="lfp__empty">
          No presets yet. Set the rules below, then keep them here under a name.
        </p>
      ) : (
        <ol className="lfp__list">
          {presets.map((p) => {
            const inForce = JSON.stringify(p.rules) === JSON.stringify(state.rules);
            return (
              <li key={p.slot} className={`lfp__row${inForce ? ' lfp__row--on' : ''}`}>
                {renaming?.slot === p.slot ? (
                  <form
                    className="lfp__rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const clean = normalisePresetName(renaming.name);
                      if (!clean) return;
                      void run(
                        `rename-${p.slot}`,
                        () => lootFilterApi.renamePreset(heroId, p.slot, clean),
                        `Renamed to “${clean}”.`,
                      ).then((ok) => ok && setRenaming(null));
                    }}
                  >
                    <label className="visually-hidden" htmlFor={`${id}-rename-${p.slot}`}>
                      New name for {p.name}
                    </label>
                    <input
                      id={`${id}-rename-${p.slot}`}
                      className="lfp__input"
                      value={renaming.name}
                      maxLength={LOOT_FILTER_PRESET_NAME_MAX}
                      onChange={(e) => setRenaming({ slot: p.slot, name: e.target.value })}
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="btn btn--small"
                      disabled={busy !== null || !normalisePresetName(renaming.name)}
                    >
                      Keep name
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="lfp__what">
                    <p className="lfp__name">
                      {p.name}
                      {inForce ? <span className="caps lfp__badge">In force</span> : null}
                    </p>
                    <p className="lfp__rules">{describeRules(p.active ? p.rules : null)}</p>
                  </div>
                )}
                <div className="lfp__actions">
                  <button
                    type="button"
                    className="btn btn--small btn--brass"
                    disabled={busy !== null || inForce}
                    aria-busy={busy === `use-${p.slot}`}
                    onClick={() =>
                      void run(
                        `use-${p.slot}`,
                        () => lootFilterApi.apply(heroId, { preset: p.slot }),
                        `“${p.name}” is now your loot filter, for drops from now on.`,
                      )
                    }
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy !== null}
                    onClick={() => setRenaming({ slot: p.slot, name: p.name })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    aria-pressed={sharing === p.slot}
                    onClick={() => {
                      setCopied(false);
                      setSharing(sharing === p.slot ? null : p.slot);
                    }}
                  >
                    Share
                  </button>
                  <button
                    type="button"
                    className="btn btn--small lfp__delete"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        `delete-${p.slot}`,
                        () => lootFilterApi.deletePreset(heroId, p.slot),
                        `“${p.name}” was removed.`,
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {shareCode ? (
        <div className="lfp__share" role="region" aria-label="Share code">
          <label className="caps lfp__label" htmlFor={`${id}-share`}>
            Share code
            {sharing === 'current'
              ? ' · the filter in force'
              : ` · ${presets[sharing as number]?.name}`}
          </label>
          <div className="lfp__code-line">
            <input
              id={`${id}-share`}
              className="lfp__input lfp__code"
              readOnly
              value={shareCode}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void navigator.clipboard?.writeText(shareCode).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="lfp__hint">
            Anyone can paste it under “Import a code”. It holds only the rules, never your items or
            your name.
          </p>
        </div>
      ) : null}

      <div className="lfp__tools">
        <form
          className="lfp__save"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <label className="caps lfp__label" htmlFor={`${id}-name`}>
            Keep the rules below as
          </label>
          <div className="lfp__code-line">
            <input
              id={`${id}-name`}
              className="lfp__input"
              placeholder="e.g. Abbey sets"
              value={name}
              maxLength={LOOT_FILTER_PRESET_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
            {full ? (
              <select
                className="lfp__input lfp__slot"
                aria-label="Preset to replace"
                value={overwrite}
                onChange={(e) => setOverwrite(Number(e.target.value))}
              >
                {presets.map((p) => (
                  <option key={p.slot} value={p.slot}>
                    Replace “{p.name}”
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="submit"
              className="btn btn--small"
              disabled={busy !== null}
              aria-busy={busy === 'save'}
            >
              {full ? 'Replace' : 'Keep'}
            </button>
          </div>
          <button
            type="button"
            className="btn btn--small lfp__share-current"
            aria-pressed={sharing === 'current'}
            onClick={() => {
              setCopied(false);
              setSharing(sharing === 'current' ? null : 'current');
            }}
          >
            Share the filter in force
          </button>
        </form>

        <form
          className="lfp__import"
          onSubmit={(e) => {
            e.preventDefault();
            void readCode();
          }}
        >
          <label className="caps lfp__label" htmlFor={`${id}-code`}>
            Import a code
          </label>
          <div className="lfp__code-line">
            <input
              id={`${id}-code`}
              className="lfp__input lfp__code"
              placeholder="wf1.…"
              value={code}
              maxLength={LOOT_FILTER_CODE_MAX_LENGTH}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setCode(e.target.value);
                setPreview('none');
              }}
            />
            <button
              type="submit"
              className="btn btn--small"
              disabled={busy !== null || code.trim() === ''}
              aria-busy={busy === 'read'}
            >
              Read
            </button>
          </div>
          {preview !== 'none' ? (
            <div className="lfp__preview" role="status">
              <p className="lfp__rules">
                <strong>This code:</strong> {describeRules(preview)}
              </p>
              <p className="lfp__hint">
                {preview
                  ? `Of the ${pack.length} items in your pack, these rules would have taken ${handled(preview)}. Nothing changes until you choose.`
                  : 'These rules filter nothing: using them turns the filter off.'}
              </p>
              <div className="lfp__actions">
                <button
                  type="button"
                  className="btn btn--small btn--brass"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      'import-use',
                      () => lootFilterApi.apply(heroId, { code: code.trim() }),
                      'The shared rules are now your loot filter, for drops from now on.',
                    ).then((ok) => {
                      if (ok) {
                        setCode('');
                        setPreview('none');
                      }
                    })
                  }
                >
                  Use now
                </button>
                {!full ? (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        'import-keep',
                        () =>
                          lootFilterApi.savePreset(heroId, {
                            slot: presets.length,
                            name: `Shared ${presets.length + 1}`,
                            code: code.trim(),
                          }),
                        `Kept as “Shared ${presets.length + 1}”. Rename it any time.`,
                      ).then((ok) => {
                        if (ok) {
                          setCode('');
                          setPreview('none');
                        }
                      })
                    }
                  >
                    Keep as a preset
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setCode('');
                    setPreview('none');
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          ) : null}
        </form>
      </div>

      {notice ? (
        <p
          className={`pack__notice pack__notice--${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
