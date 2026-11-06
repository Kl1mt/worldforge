import { routeHref } from '../lib/route';
import { LEGAL_LINKS } from './api';
import './legal.css';

/** Impressum and privacy policy, in the status bar of every screen (ticket D.2). */
export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Legal">
      {LEGAL_LINKS.map((l) => (
        <a key={l.route} className="legal-links__link" href={routeHref(l.route)}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}
