import { useEffect, useState, type ReactNode } from 'react';
import type { ApiFailure } from '../lib/api';
import { routeHref, type LegalRoute } from '../lib/route';
import { HealthLine } from '../shell/HealthLine';
import { LEGAL_TITLES, legalApi, type LegalDocument } from './api';
import { LegalLinks } from './LegalLinks';
import { parseMarkdown, type Block, type Inline } from './markdown';
import '../shell/shell.css';
import './legal.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: LegalDocument }
  | { kind: 'error'; error: ApiFailure };

/**
 * Impressum and privacy policy (ticket D.2): open to everyone, logged in or not. The text is the
 * owner's Markdown, served by the server; this screen only frames and renders it. Keyed by page
 * in `App`, so another page starts from loading.
 */
export function LegalScreen({ page }: { page: LegalRoute }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    legalApi.page(page, controller.signal).then(
      (r) => setState(r.ok ? { kind: 'ready', doc: r.value } : { kind: 'error', error: r.error }),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [page, attempt]);

  useEffect(() => {
    document.title = `${LEGAL_TITLES[page]} · Worldforge`;
    return () => {
      document.title = 'Worldforge';
    };
  }, [page]);

  return (
    <div className="shell legal">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <a className="wordmark display legal__home" href={routeHref('hub')}>
            Worldforge
          </a>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="shell__main legal__main">
        <a className="legal__back" href={routeHref('hub')}>
          ← Back to the game
        </a>
        <article className="legal__sheet panel-iron" aria-busy={state.kind === 'loading'}>
          {state.kind === 'loading' ? (
            <>
              <h1 className="legal__title display">{LEGAL_TITLES[page]}</h1>
              <p className="legal__wait" role="status">
                Unrolling the page…
              </p>
            </>
          ) : state.kind === 'error' ? (
            <>
              <h1 className="legal__title display">{LEGAL_TITLES[page]}</h1>
              <p className="legal__alert" role="alert">
                {state.error.code === 'network'
                  ? 'The server cannot be reached, so this page cannot be shown right now.'
                  : 'This page could not be loaded. Try again in a moment.'}
              </p>
              <button
                type="button"
                className="btn btn--brass"
                onClick={() => {
                  setState({ kind: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </>
          ) : (
            <>
              {state.doc.template ? (
                <p className="legal__template" role="note">
                  Template: the operator has not filled in this page yet.
                </p>
              ) : null}
              <div className="legal__prose">
                {parseMarkdown(state.doc.markdown).map(renderBlock)}
              </div>
            </>
          )}
        </article>
      </main>
      <footer className="statusbar">
        <HealthLine />
        <LegalLinks />
      </footer>
    </div>
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.t) {
    case 'h': {
      const Tag = (['h1', 'h2', 'h3'] as const)[block.level - 1]!;
      return (
        <Tag key={key} className={block.level === 1 ? 'legal__title display' : 'legal__heading'}>
          {block.c.map(renderInline)}
        </Tag>
      );
    }
    case 'p':
      return <p key={key}>{block.c.map(renderInline)}</p>;
    case 'ul':
    case 'ol': {
      const Tag = block.t;
      return (
        <Tag key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{item.map(renderInline)}</li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return <blockquote key={key}>{block.blocks.map(renderBlock)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
  }
}

function renderInline(node: Inline, key: number): ReactNode {
  switch (node.t) {
    case 'text':
      return node.v;
    case 'br':
      return <br key={key} />;
    case 'code':
      return <code key={key}>{node.v}</code>;
    case 'strong':
      return <strong key={key}>{node.c.map(renderInline)}</strong>;
    case 'em':
      return <em key={key}>{node.c.map(renderInline)}</em>;
    case 'link': {
      const external = /^https?:/i.test(node.href);
      return (
        <a
          key={key}
          href={node.href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {node.c.map(renderInline)}
        </a>
      );
    }
  }
}
