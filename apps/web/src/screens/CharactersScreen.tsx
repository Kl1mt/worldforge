import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  BANNERS,
  CHARACTER_NAME_MAX,
  CHARACTER_NAME_MIN,
  CLASSES,
  RESOURCES,
  getClass,
  validateCharacterName,
  type BannerId,
  type ClassId,
} from '@worldforge/game-core';
import { useAuth } from '../auth/AuthProvider';
import { describeCharacterFailure, type Character, type Roster } from '../characters/api';
import { useCharacters } from '../characters/CharactersProvider';
import { HeroPortrait } from '../characters/HeroPortrait';
import { useMediaQuery } from '../components/useMediaQuery';
import { formatNumber } from '../lib/format';
import { PHONE_QUERY } from '../lib/pixel';
import { routeHref } from '../lib/route';
import { HealthLine } from '../shell/HealthLine';
import { useLogout } from '../shell/useLogout';
import '../shell/shell.css';
import './gate.css';
import './characters.css';

const resourceName = (classId: ClassId) =>
  RESOURCES.find((r) => r.id === getClass(classId).resource)?.name ?? '';

const enterGame = () => window.location.assign(routeHref('hub'));

/**
 * The muster hall: character select and creation. Shown after login until a character is
 * active, and reachable from the game shell to switch characters.
 */
export function CharactersScreen() {
  const { state } = useCharacters();
  // The route guard only renders this screen once the roster is loaded.
  if (state.kind !== 'ready') return null;
  return (
    <HallLayout>
      <Hall roster={state.roster} />
    </HallLayout>
  );
}

function HallLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { leaving, error, logout } = useLogout();
  const account = auth.state.kind === 'authenticated' ? auth.state.account : null;
  return (
    <div className="shell hall">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <span className="wordmark display">Worldforge</span>
          <div className="purse">
            {account ? (
              <div className="purse__who">
                <span className="purse__name">{account.displayName}</span>
                <span className="purse__class">Account</span>
              </div>
            ) : null}
            <button
              type="button"
              className="btn topbar__leave"
              onClick={logout}
              disabled={leaving}
              aria-busy={leaving}
            >
              {leaving ? 'Leaving…' : 'Log out'}
            </button>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="shell__main hall__main">
        {children}
      </main>

      <footer className="statusbar">
        <HealthLine />
        {error ? (
          <p className="statusbar__alert" role="alert">
            {error}
          </p>
        ) : null}
      </footer>
    </div>
  );
}

function Hall({ roster }: { roster: Roster }) {
  const hasCharacters = roster.characters.length > 0;
  const freeSlots = roster.slots.total - roster.slots.used;
  const [creating, setCreating] = useState(!hasCharacters);

  if (creating && freeSlots > 0) {
    return (
      <CreateForm
        first={!hasCharacters}
        onCancel={hasCharacters ? () => setCreating(false) : undefined}
        onCreated={() => setCreating(false)}
      />
    );
  }
  return <RosterView roster={roster} onCreate={() => setCreating(true)} />;
}

/* ── Roster ─────────────────────────────────────────────────────────────── */

function RosterView({ roster, onCreate }: { roster: Roster; onCreate: () => void }) {
  const { select } = useCharacters();
  const phone = useMediaQuery(PHONE_QUERY);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const { used, total } = roster.slots;
  const empties = Math.max(0, total - used);

  const play = async (c: Character) => {
    if (pending) return;
    if (c.id === roster.activeCharacterId) return enterGame();
    setPending(c.id);
    setError(null);
    const failure = await select(c.id);
    setPending(null);
    if (!failure) return enterGame();
    setError(describeCharacterFailure(failure));
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  return (
    <section className="hall__section" aria-labelledby="hall-title">
      <header className="hall__head">
        <p className="caps hall__eyebrow">Graumark · Muster roll</p>
        <h1 id="hall-title" className="hall__title display">
          Choose your hero
        </h1>
        <p className="hall__lede">
          {used} of {total} {total === 1 ? 'slot' : 'slots'} filled. Each hero keeps their own
          level, gear and gold.
        </p>
      </header>

      {error ? (
        <p ref={alertRef} className="gate__alert hall__alert" role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}

      <ul className="muster">
        {roster.characters.map((c) => {
          const cls = getClass(c.classId);
          const active = c.id === roster.activeCharacterId;
          const busy = pending === c.id;
          return (
            <li key={c.id} className={`muster__slot${active ? ' muster__slot--active' : ''}`}>
              <button
                type="button"
                className="muster__card"
                onClick={() => void play(c)}
                disabled={pending !== null}
                aria-busy={busy}
                aria-label={`Play ${c.name}, level ${c.level} ${cls.name}${active ? ', last played' : ''}`}
              >
                {active ? <span className="muster__mark caps">Last played</span> : null}
                <span className="muster__niche">
                  <HeroPortrait
                    classId={c.classId}
                    banner={c.appearance.banner}
                    scale={phone ? 1 : 2}
                    alt=""
                  />
                </span>
                <span className="muster__plaque">
                  <span className="muster__name display">{c.name}</span>
                  <span className="muster__line">
                    Level {c.level} {cls.name}
                  </span>
                  <span className="muster__gold">
                    <span className="purse__coin" aria-hidden="true" />
                    {formatNumber(c.gold)} gold
                  </span>
                  <span className="btn btn--brass muster__play" aria-hidden="true">
                    {busy ? 'Entering…' : active ? 'Continue' : 'Play'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}

        {Array.from({ length: empties }, (_, i) => (
          <li key={`empty-${i}`} className="muster__slot muster__slot--empty">
            <div className="muster__card muster__card--empty">
              <span className="muster__niche muster__niche--empty" aria-hidden="true">
                <span className="muster__lozenge" />
              </span>
              <span className="muster__plaque">
                <span className="muster__name display">Empty slot</span>
                <span className="muster__line">A banner waits to be raised.</span>
                <button type="button" className="btn muster__play" onClick={onCreate}>
                  Forge a hero
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      {empties === 0 ? (
        <p className="hall__fine">
          All {total} slots are filled. More slots will be earned through play in a later season.
        </p>
      ) : null}
    </section>
  );
}

/* ── Creation ───────────────────────────────────────────────────────────── */

type FieldName = 'name' | 'classId' | 'banner';

function CreateForm({
  first,
  onCancel,
  onCreated,
}: {
  first: boolean;
  onCancel: (() => void) | undefined;
  /** Called after a successful create, before entering the game. */
  onCreated: () => void;
}) {
  const { create } = useCharacters();
  const phone = useMediaQuery(PHONE_QUERY);
  const [name, setName] = useState('');
  const [classId, setClassId] = useState<ClassId>('warrior');
  const [banner, setBanner] = useState<BannerId>('ash');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const nameId = useId();
  const cls = getClass(classId);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // The shared game-core rule gives instant feedback; the server checks it again.
    const checked = validateCharacterName(name);
    if (!checked.ok) {
      setErrors({ name: checked.message });
      setFormError(null);
      requestAnimationFrame(() => nameRef.current?.focus());
      return;
    }
    setBusy(true);
    setFormError(null);
    const failure = await create({ name: checked.name, classId, appearance: { banner } });
    setBusy(false);
    if (!failure) {
      // Leave the form so that coming back to this screen shows the roster.
      onCreated();
      return enterGame();
    }
    const fieldErrors: Partial<Record<FieldName, string>> = {};
    if (failure.fields.name) fieldErrors.name = failure.fields.name;
    if (failure.fields.classId) fieldErrors.classId = failure.fields.classId;
    if (failure.fields['appearance.banner'])
      fieldErrors.banner = failure.fields['appearance.banner'];
    setErrors(fieldErrors);
    setFormError(describeCharacterFailure(failure));
    requestAnimationFrame(() =>
      fieldErrors.name ? nameRef.current?.focus() : alertRef.current?.focus(),
    );
  };

  const shownName = name.trim() || 'Unnamed';
  const bannerName = BANNERS.find((b) => b.id === banner)?.name ?? '';

  return (
    <section className="hall__section forge" aria-labelledby="hall-title">
      <header className="hall__head">
        <p className="caps hall__eyebrow">Graumark · Muster roll</p>
        <h1 id="hall-title" className="hall__title display">
          {first ? 'Forge your first hero' : 'Forge a hero'}
        </h1>
        <p className="hall__lede">
          {first
            ? 'Your ledger holds no heroes yet. Choose a name, a class and a banner.'
            : 'Choose a name, a class and a banner.'}{' '}
          The class is chosen for good.
        </p>
      </header>

      <div className="forge__body">
        <figure className="forge__preview" aria-label="Preview">
          <div className="forge__niche">
            <HeroPortrait
              classId={classId}
              banner={banner}
              scale={phone ? 1 : 3}
              alt={`${shownName} the ${cls.name}, in front of a ${bannerName.toLowerCase()} banner`}
            />
          </div>
          <figcaption className="forge__plaque">
            <span className="forge__name display">{shownName}</span>
            <span className="muster__line">
              Level 1 {cls.name} · {resourceName(classId)}
            </span>
          </figcaption>
        </figure>

        <form className="forge__form panel-iron" onSubmit={onSubmit} noValidate aria-busy={busy}>
          {formError ? (
            <p ref={alertRef} className="gate__alert forge__alert" role="alert" tabIndex={-1}>
              {formError}
            </p>
          ) : null}

          <div className={`field${errors.name ? ' field--invalid' : ''}`}>
            <label className="field__label caps" htmlFor={nameId}>
              Name
            </label>
            <div className="field__well">
              <input
                ref={nameRef}
                id={nameId}
                name="name"
                className="field__input"
                type="text"
                autoComplete="off"
                autoCapitalize="words"
                spellCheck={false}
                maxLength={CHARACTER_NAME_MAX + 8}
                value={name}
                disabled={busy}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={`${nameId}-${errors.name ? 'error' : 'hint'}`}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors(({ name: _cleared, ...rest }) => rest);
                }}
              />
            </div>
            {errors.name ? (
              <p id={`${nameId}-error`} className="field__error">
                {errors.name}
              </p>
            ) : (
              <p id={`${nameId}-hint`} className="field__hint">
                {CHARACTER_NAME_MIN}–{CHARACTER_NAME_MAX} letters; one &rsquo; or - may join parts.
                Unique across the world.
              </p>
            )}
          </div>

          <fieldset className="forge__group" disabled={busy}>
            <legend className="field__label caps">Class</legend>
            <div className="forge__classes">
              {CLASSES.map((c) => (
                <label
                  key={c.id}
                  className={`class-card${c.id === classId ? ' class-card--chosen' : ''}`}
                >
                  <input
                    type="radio"
                    name="classId"
                    value={c.id}
                    checked={c.id === classId}
                    onChange={() => setClassId(c.id)}
                    className="class-card__input"
                  />
                  <span className="class-card__name display">{c.name}</span>
                  <span className="class-card__resource caps">{resourceName(c.id)}</span>
                  <span className="class-card__identity">{c.identity}</span>
                </label>
              ))}
            </div>
            {errors.classId ? <p className="field__error">{errors.classId}</p> : null}
          </fieldset>

          <fieldset className="forge__group" disabled={busy}>
            <legend className="field__label caps">Banner</legend>
            <div className="forge__banners">
              {BANNERS.map((b) => (
                <label
                  key={b.id}
                  className={`banner-chip banner-${b.id}${b.id === banner ? ' banner-chip--chosen' : ''}`}
                >
                  <input
                    type="radio"
                    name="banner"
                    value={b.id}
                    checked={b.id === banner}
                    onChange={() => setBanner(b.id)}
                    className="banner-chip__input"
                  />
                  <span className="banner-chip__swatch" aria-hidden="true" />
                  {b.name}
                </label>
              ))}
            </div>
            {errors.banner ? <p className="field__error">{errors.banner}</p> : null}
          </fieldset>

          <button type="submit" className="btn btn--brass gate__submit" disabled={busy}>
            {busy ? 'Forging…' : 'Forge hero'}
          </button>
          {onCancel ? (
            <button type="button" className="btn forge__back" onClick={onCancel} disabled={busy}>
              Back to the roster
            </button>
          ) : null}
        </form>
      </div>
    </section>
  );
}
