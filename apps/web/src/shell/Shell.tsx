import { useEffect, useRef, type ReactNode } from 'react';
import { getClass } from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';
import { routeHref, type GameRoute } from '../lib/route';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { HealthLine } from './HealthLine';
import { useLogout } from './useLogout';
import './shell.css';

const NAV: { route: GameRoute; label: string; hint: string }[] = [
  { route: 'area', label: 'Fields', hint: 'Abandoned Fields' },
  { route: 'character', label: 'Character', hint: 'Equipment & stats' },
  { route: 'inventory', label: 'Pack', hint: 'Inventory' },
];

export function Shell({ route, children }: { route: GameRoute; children: ReactNode }) {
  const auth = useAuth();
  const account = auth.state.kind === 'authenticated' ? auth.state.account : null;
  const character = useActiveCharacter();
  const { leaving, error: logoutError, logout } = useLogout();
  const cls = getClass(character.classId);
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
            aria-current={route === n.route ? 'page' : undefined}
          >
            <span className="nav__label">{n.label}</span>
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
          <a className="wordmark display" href={routeHref('area')}>
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
        {children}
      </main>

      <footer className="statusbar">
        <HealthLine />
        {logoutError ? (
          <p className="statusbar__alert" role="alert">
            {logoutError}
          </p>
        ) : null}
        <span className="statusbar__note">
          {account ? `Signed in as ${account.displayName} · ` : null}combat, items and stats are
          mock data
        </span>
      </footer>

      <nav className="bottombar" aria-label="Main (mobile)">
        {nav('bottom')}
      </nav>
    </div>
  );
}
