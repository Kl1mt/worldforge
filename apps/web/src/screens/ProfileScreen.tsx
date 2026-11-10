import { CrestRim, HeroLook } from '../cosmetics/Cosmetics';
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  GUILD_ROLE_LABELS,
  ACHIEVEMENTS,
  MAX_SHOWN_ACHIEVEMENTS,
  PROFILE_VISIBILITIES,
  PROFILE_VISIBILITY_LABELS,
  findAchievement,
  getClass,
  type AchievementDefinition,
  type ProfileVisibility,
  type ReportTarget,
} from '@worldforge/game-core';
import { useAuth } from '../auth/AuthProvider';
import { HeroPortrait } from '../characters/HeroPortrait';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { findSprite } from '../content/assets';
import { slotName, toItemView, type ItemView } from '../game/items';
import type { ApiFailure } from '../lib/api';
import { guildHref, profileHandleFromHash, profileHref } from '../lib/route';
import { Crest } from '../social/Crest';
import {
  describeSocialFailure,
  socialApi,
  type Profile,
  type ProfileHero,
  type ProfileSettings,
} from '../social/api';
import { ReportDialog } from '../social/ReportDialog';
import { FramedPlate, ShownTitle } from '../social/Prestige';
import { HonoursPanel } from './HonoursPanel';
import './characters.css';
import './gate.css';
import './profile.css';
import '../social/social.css';

/**
 * Public profiles (ticket 4.2, docs/SOCIAL.md "Profiles"): a herald's herald for one player, with
 * their heroes, the deeds they chose to show and, if they want, one hero's arms. `#/profile` is
 * your own (with the settings), `#/profile/<handle>` anyone's. A profile you may not see looks
 * exactly like a name nobody bears.
 */
type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; error: ApiFailure }
  | { kind: 'ready'; profile: Profile };

function useHashHandle(): string | null {
  const [handle, setHandle] = useState(() => profileHandleFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setHandle(profileHandleFromHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return handle;
}

export function ProfileScreen() {
  const auth = useAuth();
  const me = auth.state.kind === 'authenticated' ? auth.state.account : null;
  const handle = useHashHandle() ?? me?.handle ?? null;
  // The result is kept with the handle it belongs to: another handle reads as loading.
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<{ target: ReportTarget; label: string } | null>(null);
  const key = `${handle}:${attempt}`;
  // A refresh of the same profile (after saving the settings) keeps showing the old one.
  const sameHandle = result?.key.startsWith(`${handle}:`) && result.load.kind === 'ready';
  const load: Load = result?.key === key || sameHandle ? result!.load : { kind: 'loading' };

  useEffect(() => {
    if (!handle) return;
    const controller = new AbortController();
    socialApi.profile(handle, controller.signal).then(
      (res) => {
        const next: Load = res.ok
          ? { kind: 'ready', profile: res.value.profile }
          : res.error.code === 'not_found'
            ? { kind: 'missing' }
            : { kind: 'error', error: res.error };
        if (!controller.signal.aborted) setResult({ key: `${handle}:${attempt}`, load: next });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [handle, attempt]);

  const profile = load.kind === 'ready' ? load.profile : null;
  const name = profile ? (profile.displayName ?? 'A name withheld') : null;

  return (
    <section className="herald" aria-labelledby="herald-title">
      <header className="herald__head">
        {profile?.prestige.frame ? <HonourPlate profile={profile} /> : null}
        {profile && !profile.prestige.frame && profile.prestige.crest ? (
          <CrestPlate profile={profile} />
        ) : null}
        <div className="herald__who">
          <p className="caps">{profile?.self ? 'Your profile' : 'Profile'}</p>
          <h1 id="herald-title" className="display">
            {name ?? (load.kind === 'missing' ? 'No such name' : 'The herald of names')}
          </h1>
          {profile?.prestige.title || profile?.prestige.cosmeticTitle ? (
            <p className="herald__title">
              <ShownTitle shown={profile.prestige} />
            </p>
          ) : null}
          {profile ? (
            <p className="herald__handle">
              @{profile.handle}
              {profile.self && profile.visibility ? (
                <span className={`herald__seen herald__seen--${profile.visibility}`}>
                  Seen by: {PROFILE_VISIBILITY_LABELS[profile.visibility]}
                </span>
              ) : null}
            </p>
          ) : null}
          {profile?.guild ? (
            <p className="herald__guild">
              <Crest emblem={profile.guild.emblem} size="sm" />
              <span>
                {GUILD_ROLE_LABELS[profile.guild.role]} of{' '}
                <a href={guildHref(profile.guild.handle)}>
                  {profile.guild.name} [{profile.guild.tag}]
                </a>
              </span>
            </p>
          ) : null}
        </div>
        {profile && !profile.self ? (
          <button
            type="button"
            className="btn herald__report"
            onClick={() =>
              setReport({
                target: { kind: 'player', handle: profile.handle },
                label: name ?? 'this player',
              })
            }
          >
            Report player
          </button>
        ) : null}
        <FindPlayer />
      </header>

      {load.kind === 'loading' ? (
        <p className="herald__wait" role="status">
          The herald unrolls the parchment…
        </p>
      ) : null}
      {load.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeSocialFailure(load.error)}</p>
          <button type="button" className="btn btn--small" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {load.kind === 'missing' ? (
        <div className="herald__missing panel-ledger">
          <p className="display">No one by that name walks these roads.</p>
          <p>The player may not exist, or keeps their profile to themselves.</p>
          <p>
            <a href={profileHref()}>Back to your own profile</a>
          </p>
        </div>
      ) : null}

      {profile ? (
        <div className="herald__body">
          <div className="herald__main">
            <Heroes profile={profile} onReport={setReport} />
            {profile.showcase ? <Showcase showcase={profile.showcase} /> : null}
          </div>
          <aside className="herald__side">
            <Deeds profile={profile} />
            {profile.self ? <SettingsPanel onSaved={() => setAttempt((n) => n + 1)} /> : null}
            {profile.self ? <HonoursPanel onSaved={() => setAttempt((n) => n + 1)} /> : null}
          </aside>
        </div>
      ) : null}

      <ReportDialog
        open={report !== null}
        onClose={() => setReport(null)}
        {...(report ? { target: report } : {})}
      />
    </section>
  );
}

function FindPlayer() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = name.trim();
    if (!q) {
      setError('Enter a display name.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await socialApi.lookup(q);
    setBusy(false);
    if (!res.ok) {
      setError(describeSocialFailure(res.error));
      return;
    }
    setName('');
    window.location.hash = profileHref(res.value.player.handle);
  };

  return (
    <form className="herald__find" onSubmit={submit} noValidate role="search">
      <label className="field__label caps" htmlFor={id}>
        Find a player
      </label>
      <div className="herald__find-row">
        <div className="field__well">
          <input
            id={id}
            className="field__input"
            value={name}
            maxLength={64}
            autoComplete="off"
            placeholder="Display name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
          {busy ? 'Searching…' : 'Find'}
        </button>
      </div>
      {error ? (
        <p id={`${id}-err`} className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function heroLine(h: ProfileHero): string {
  return `Level ${h.level} ${getClass(h.classId).name}`;
}

function Heroes({
  profile,
  onReport,
}: {
  profile: Profile;
  onReport: (r: { target: ReportTarget; label: string }) => void;
}) {
  return (
    <section className="herald__heroes panel-iron" aria-labelledby="herald-heroes">
      <h2 id="herald-heroes" className="rule-heading">
        Heroes
      </h2>
      {profile.characters.length === 0 ? (
        <p className="herald__empty">No hero has taken up arms yet.</p>
      ) : (
        <ul className="herald__hero-list">
          {profile.characters.map((h, i) => (
            <li key={`${h.name ?? 'hidden'}-${i}`} className="herald__hero">
              <HeroPortrait
                classId={h.classId}
                banner={h.appearance.banner}
                scale={1}
                alt={`${getClass(h.classId).name} portrait`}
                palette={h.palette ?? null}
                bannerStyle={profile.prestige.banner ?? null}
              />
              <div className="herald__hero-text">
                <p className={`herald__hero-name display${h.name ? '' : ' is-withheld'}`}>
                  {h.name ?? 'Name withheld'}
                </p>
                <p className="herald__hero-line">{heroLine(h)}</p>
                {!profile.self && h.name ? (
                  <button
                    type="button"
                    className="herald__flag"
                    onClick={() =>
                      onReport({
                        target: { kind: 'characterName', handle: profile.handle, name: h.name! },
                        label: `the hero name “${h.name}”`,
                      })
                    }
                  >
                    Report name
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function showcaseViews(equipped: NonNullable<Profile['showcase']>['equipped']): ItemView[] {
  return equipped.map((i) =>
    toItemView({
      ...i,
      id: `showcase-${i.slot}`,
      equippedSlot: i.slot,
      source: 'showcase',
      createdAt: '',
      variant: i.variant as never,
    }),
  );
}

function Showcase({ showcase }: { showcase: NonNullable<Profile['showcase']> }) {
  const items = showcaseViews(showcase.equipped);
  const [selected, setSelected] = useState<string | null>(items[0]?.id ?? null);
  const item = items.find((i) => i.id === selected) ?? null;
  const title = showcase.name ? `Arms of ${showcase.name}` : 'Arms of a hero';
  return (
    <section className="herald__arms panel-iron" aria-labelledby="herald-arms">
      <h2 id="herald-arms" className="rule-heading">
        {title}
      </h2>
      <p className="herald__arms-line">{heroLine(showcase)}</p>
      {items.length === 0 ? (
        <p className="herald__empty">This hero fights with bare hands for now.</p>
      ) : (
        <>
          <ul className="herald__rack" aria-label={`${title}: equipped items`}>
            {items.map((i) => (
              <li key={i.id}>
                <ItemFrame
                  item={i}
                  scale={2}
                  selected={i.id === selected}
                  onSelect={() => setSelected(i.id)}
                  context={slotName(i.equippedSlot!)}
                />
              </li>
            ))}
          </ul>
          {item ? (
            <div className="herald__inspect" aria-live="polite">
              <ItemTooltip
                item={item}
                caption={`Equipped · ${slotName(item.equippedSlot!)}`}
                setPack={{ equipped: items, items }}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * A deed's seal: its 32×32 icon (art ticket A.8) in a sunken medallion ringed in the deed's kind.
 * If the icon is not registered or fails to load, the wax disc with the deed's initial stands in.
 */
function Seal({ a }: { a: AchievementDefinition }) {
  const sprite = findSprite(a.assetId);
  const [failed, setFailed] = useState<string | null>(null);
  if (sprite && failed !== sprite.path) {
    return (
      <span className={`seal seal--art seal--${a.category}`} aria-hidden="true">
        <img
          className="seal__icon pixel"
          src={sprite.path}
          alt=""
          width={sprite.width}
          height={sprite.height}
          draggable={false}
          onError={() => setFailed(sprite.path)}
        />
      </span>
    );
  }
  return (
    <span className={`seal seal--${a.category}`} aria-hidden="true">
      <span className="seal__glyph">{a.name.replace(/^The /, '').charAt(0)}</span>
    </span>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function Deeds({ profile }: { profile: Profile }) {
  const shown = profile.achievements
    .map((s) => ({ ...s, def: findAchievement(s.id) }))
    .filter((s): s is typeof s & { def: AchievementDefinition } => s.def !== undefined);
  return (
    <section className="herald__deeds panel-ledger" aria-labelledby="herald-deeds">
      <h2 id="herald-deeds" className="rule-heading">
        Deeds
      </h2>
      {shown.length === 0 ? (
        <p className="herald__empty">
          {profile.self
            ? 'You show no deeds yet. Choose up to five below.'
            : 'No deeds are shown on this herald.'}
        </p>
      ) : (
        <ul className="deeds">
          {shown.map((s) => (
            <li key={s.id} className="deed">
              <Seal a={s.def} />
              <div>
                <p className="deed__name display">{s.def.name}</p>
                <p className="deed__what">{s.def.description}</p>
                <p className="deed__when">{DAY.format(new Date(`${s.awardedOn}T00:00:00Z`))}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const VISIBILITY_HINT: Record<ProfileVisibility, string> = {
  public: 'Every player can find your profile.',
  friendsAndGuild: 'Only your friends (and guildmates, once guilds arrive).',
  hidden: 'Nobody but you. Others are told no such name exists.',
};

type SettingsLoad =
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiFailure }
  | { kind: 'ready'; settings: ProfileSettings };

function SettingsPanel({ onSaved }: { onSaved: () => void }) {
  const [load, setLoad] = useState<SettingsLoad>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [visibility, setVisibility] = useState<ProfileVisibility>('public');
  const [shown, setShown] = useState<string[]>([]);
  const [showcase, setShowcase] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = useId();

  const apply = (s: ProfileSettings) => {
    setLoad({ kind: 'ready', settings: s });
    setVisibility(s.visibility);
    setShown(s.shown);
    setShowcase(s.showcaseCharacterId ?? '');
  };

  useEffect(() => {
    const controller = new AbortController();
    socialApi.profileSettings(controller.signal).then(
      (res) => (res.ok ? apply(res.value) : setLoad({ kind: 'error', error: res.error })),
      () => undefined,
    );
    return () => controller.abort();
  }, [attempt]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await socialApi.saveProfile({
      visibility,
      shown,
      showcaseCharacterId: showcase || null,
    });
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: describeSocialFailure(res.error) });
      return;
    }
    apply(res.value);
    setMessage({ ok: true, text: 'Your herald is amended.' });
    onSaved();
  };

  const toggle = (id: string) =>
    setShown((s) =>
      s.includes(id)
        ? s.filter((x) => x !== id)
        : s.length < MAX_SHOWN_ACHIEVEMENTS
          ? [...s, id]
          : s,
    );

  return (
    <section className="herald__settings panel-iron" aria-labelledby="herald-settings">
      <h2 id="herald-settings" className="rule-heading">
        How others see you
      </h2>
      {load.kind === 'loading' ? (
        <p className="herald__wait" role="status">
          Fetching your seals…
        </p>
      ) : null}
      {load.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeSocialFailure(load.error)}</p>
          <button type="button" className="btn btn--small" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {load.kind === 'ready' ? (
        <form className="herald__form" onSubmit={submit} noValidate>
          <fieldset className="herald__group">
            <legend className="caps">Who may see your profile</legend>
            {PROFILE_VISIBILITIES.map((v) => (
              <label key={v} className="herald__choice">
                <input
                  type="radio"
                  name={`${ids}-vis`}
                  checked={visibility === v}
                  onChange={() => setVisibility(v)}
                />
                <span>
                  <strong>{PROFILE_VISIBILITY_LABELS[v]}</strong>
                  <span className="herald__hint">{VISIBILITY_HINT[v]}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="herald__group">
            <legend className="caps">
              Deeds to show ({shown.length} / {MAX_SHOWN_ACHIEVEMENTS})
            </legend>
            <ul className="ledger-deeds">
              {ACHIEVEMENTS.map((a) => {
                const earned = load.settings.earned.find((e) => e.id === a.id);
                const at = shown.indexOf(a.id);
                const full = at < 0 && shown.length >= MAX_SHOWN_ACHIEVEMENTS;
                return (
                  <li key={a.id} className={`ledger-deed${earned ? '' : ' is-locked'}`}>
                    <Seal a={a} />
                    {earned ? (
                      <label className="ledger-deed__pick">
                        <input
                          type="checkbox"
                          checked={at >= 0}
                          disabled={full}
                          onChange={() => toggle(a.id)}
                        />
                        <span>
                          <span className="ledger-deed__name">{a.name}</span>
                          <span className="herald__hint">
                            {a.description}
                            {earned.characterName ? ` · ${earned.characterName}` : ''}
                          </span>
                        </span>
                        {at >= 0 ? <span className="ledger-deed__order">{at + 1}</span> : null}
                      </label>
                    ) : (
                      <span>
                        <span className="ledger-deed__name">{a.name}</span>
                        <span className="herald__hint">{a.description} · Not yet earned</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <div className="field">
            <label className="field__label caps" htmlFor={`${ids}-showcase`}>
              Show one hero’s arms
            </label>
            <div className="field__well">
              <select
                id={`${ids}-showcase`}
                className="field__input"
                value={showcase}
                onChange={(e) => setShowcase(e.target.value)}
              >
                <option value="">No showcase</option>
                {load.settings.characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="field__hint">Others see that hero’s equipped gear, never the pack.</p>
          </div>

          {message ? (
            <p
              className={message.ok ? 'herald__saved' : 'gate__alert'}
              role={message.ok ? 'status' : 'alert'}
            >
              {message.text}
            </p>
          ) : null}
          <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
            {busy ? 'Sealing…' : 'Save'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

/**
 * Ticket 5.3: the owner's chosen season frame (A.10's art at ×4) around their first hero's class
 * portrait (128 px in the 144 px window); the hero's name stays out of it (it may be hidden).
 */
/**
 * Ticket 6.8: without a season frame, the owner's crest style around their first hero (in its
 * appearance), at ×4 like the frame.
 */
function CrestPlate({ profile }: { profile: Profile }) {
  const hero = profile.characters[0];
  return (
    <CrestRim id={profile.prestige.crest} scale={4}>
      {hero ? <HeroLook classId={hero.classId} palette={hero.palette} scale={1} alt="" /> : null}
    </CrestRim>
  );
}

function HonourPlate({ profile }: { profile: Profile }) {
  const hero = profile.characters[0];
  return (
    <FramedPlate frame={profile.prestige.frame} scale={4}>
      {hero ? (
        // Ticket 6.8: in the hero's appearance.
        <HeroLook classId={hero.classId} palette={hero.palette} scale={1} alt="" />
      ) : null}
    </FramedPlate>
  );
}
