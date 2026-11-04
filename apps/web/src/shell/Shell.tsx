import { useEffect, useRef, type ReactNode } from 'react';
import { getClass } from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { routeHref, type Route } from '../lib/route';
import { CHARACTER } from '../mock/character';
import { HealthLine } from './HealthLine';
import './shell.css';

const NAV: { route: Route; label: string; hint: string }[] = [
  { route: 'area', label: 'Fields', hint: 'Abandoned Fields' },
  { route: 'character', label: 'Character', hint: 'Equipment & stats' },
  { route: 'inventory', label: 'Pack', hint: 'Inventory' },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const cls = getClass(CHARACTER.classId);
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
            <div className="purse__who">
              <span className="purse__name">{CHARACTER.name}</span>
              <span className="purse__class">
                Level {CHARACTER.level} {cls.name}
              </span>
            </div>
            <div className="purse__gold" aria-label={`${formatNumber(CHARACTER.gold)} gold`}>
              <span className="purse__coin" aria-hidden="true" />
              {formatNumber(CHARACTER.gold)}
            </div>
          </div>
        </div>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="shell__main">
        {children}
      </main>

      <footer className="statusbar">
        <HealthLine />
        <span className="statusbar__note">Phase 0 prototype · mock data</span>
      </footer>

      <nav className="bottombar" aria-label="Main (mobile)">
        {nav('bottom')}
      </nav>
    </div>
  );
}
