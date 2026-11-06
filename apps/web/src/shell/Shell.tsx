import { useEffect, useRef, type ReactNode } from 'react';
import { LegalLinks } from '../legal/LegalLinks';
import { SANCTION_LABELS, getArea, getClass, isStaff } from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';
import { routeHref, type GameRoute } from '../lib/route';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { ReturnSummaryDialog } from '../game/ReturnSummary';
import { useGame } from '../game/GameProvider';
import { FirstSteps, ReopenGuide } from '../onboarding/FirstSteps';
import { Notices } from '../onboarding/Notices';
import { useOnboarding } from '../onboarding/OnboardingProvider';
import { HealthLine } from './HealthLine';
import { useLogout } from './useLogout';
import { useStanding } from '../social/useStanding';
import { describeSanction } from '../social/api';
import '../social/social.css';
import './shell.css';

interface NavEntry {
  route: GameRoute;
  label: string;
  hint: string;
  /** Other routes that light this entry up (the town's buildings belong to the town). */
  also?: GameRoute[];
}

function navEntries(areaName: string): NavEntry[] {
  return [
    { route: 'hub', label: 'Town', hint: 'Graumark', also: ['tavern', 'forge', 'merchant'] },
    { route: 'map', label: 'Map', hint: 'Choose an area', also: ['crypt'] },
    { route: 'area', label: 'Area', hint: areaName },
    { route: 'character', label: 'Character', hint: 'Equipment & stats' },
    { route: 'inventory', label: 'Pack', hint: 'Inventory' },
  ];
}

export function Shell({ route, children }: { route: GameRoute; children: ReactNode }) {
  const auth = useAuth();
  const account = auth.state.kind === 'authenticated' ? auth.state.account : null;
  const character = useActiveCharacter();
  const { leaving, error: logoutError, logout } = useLogout();
  const cls = getClass(character.classId);
  const { areaId } = useGame();
  const NAV = navEntries(getArea(areaId).name);
  const { newItems, newQuests } = useOnboarding();
  // "New" counts on the nav (ticket 2.7): the Pack for unseen drops, the Town for the Tavern.
  const fresh: Partial<Record<GameRoute, number>> = {
    inventory: newItems.size,
    hub: newQuests.size,
  };
  // Ticket 4.1: a sanction that limits the player is named on every screen ("why can't I post?").
  const { state: standing, reload: reloadStanding } = useStanding();
  useEffect(() => {
    if (route === 'account') reloadStanding();
  }, [route, reloadStanding]);
  const limits =
    standing.kind === 'ready'
      ? standing.standing.sanctions.filter((x) => x.kind !== 'suspend')
      : [];
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the new screen on navigation (not on first load) for keyboard users.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [route]);

  const nav = (variant: 'top' | 'bottom') => (
    <ul className={`nav nav--${variant}`}>
      {NAV.map((n) => (
        <li key={n.route}>
          <a
            href={routeHref(n.route)}
            className="nav__link"
            aria-current={route === n.route || n.also?.includes(route) ? 'page' : undefined}
          >
            <span className="nav__label">
              {n.label}
              {fresh[n.route] ? (
                <span className="new-tag nav__new">
                  {variant === 'top' ? `${fresh[n.route]} new` : 'New'}
                  <span className="visually-hidden">
                    {n.route === 'hub' ? ' at the Tavern' : ' items'}
                  </span>
                </span>
              ) : null}
            </span>
            {variant === 'top' ? <span className="nav__hint">{n.hint}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <a className="wordmark display" href={routeHref('hub')}>
            Worldforge
          </a>
          <nav className="topbar__nav" aria-label="Main">
            {nav('top')}
          </nav>
          <div className="purse">
            <a
              className="purse__who"
              href={routeHref('characters')}
              aria-label={`${character.name}, level ${character.level} ${cls.name}. Change character`}
            >
              <span className="purse__name">{character.name}</span>
              <span className="purse__class">
                Level {character.level} {cls.name} · Change
              </span>
            </a>
            <div className="purse__gold" aria-label={`${formatNumber(character.gold)} gold`}>
              <span className="purse__coin" aria-hidden="true" />
              {formatNumber(character.gold)}
            </div>
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

      <main id="main" ref={mainRef} tabIndex={-1} className="shell__main">
        {route !== 'account'
          ? limits.map((x) => (
              <p
                key={x.id}
                className={`standing-strip${x.kind === 'rename' ? ' standing-strip--rename' : ''}`}
              >
                <strong>{SANCTION_LABELS[x.kind]}.</strong> {describeSanction(x)}{' '}
                <a href={routeHref('account')}>{x.kind === 'rename' ? 'Choose a name' : 'Why?'}</a>
              </p>
            ))
          : null}
        <FirstSteps route={route} />
        {children}
      </main>

      <footer className="statusbar">
        <HealthLine />
        {logoutError ? (
          <p className="statusbar__alert" role="alert">
            {logoutError}
          </p>
        ) : null}
        <ReopenGuide />
        {account ? (
          <span className="statusbar__note">Signed in as {account.displayName}</span>
        ) : null}
        <a className="statusbar__link" href={routeHref('account')}>
          Account &amp; safety
        </a>
        {account && isStaff(account.role) ? (
          <a className="statusbar__link" href={routeHref('moderation')}>
            Moderator queue
          </a>
        ) : null}
        <LegalLinks />
      </footer>

      <nav className="bottombar" aria-label="Main (mobile)">
        {nav('bottom')}
      </nav>

      <Notices />
      <ReturnSummaryDialog heroName={character.name} />
    </div>
  );
}
