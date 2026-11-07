import { Component, type ErrorInfo, type ReactNode } from 'react';
import { routeHref } from '../lib/route';
import { isChunkLoadError, reloadPage } from './chunks';
import './reload.css';

export type ReloadFailure = 'chunk' | 'other';

interface State {
  failure: ReloadFailure | null;
}

/**
 * Ticket F.4: a screen that throws while rendering (most often an old build whose lazily loaded
 * file is gone after a deploy) shows an in-world panel with a Reload button instead of a blank
 * page. The Shell keys it by route, so moving to another screen tries again.
 */
export class ReloadBoundary extends Component<
  { children: ReactNode; /** Offer "Back to town" (inside the game shell). */ town?: boolean },
  State
> {
  override state: State = { failure: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failure: isChunkLoadError(error) ? 'chunk' : 'other' };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('screen failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failure) {
      return <ReloadPanel failure={this.state.failure} town={this.props.town ?? false} />;
    }
    return this.props.children;
  }
}

/** The in-world error: what happened in plain words, and the way out. */
export function ReloadPanel({
  failure,
  town = false,
  reload = reloadPage,
}: {
  failure: ReloadFailure;
  town?: boolean;
  reload?: () => void;
}) {
  return (
    <section className="reload-panel panel-iron" role="alert" aria-labelledby="reload-panel-title">
      <p className="caps reload-panel__kind">Word from the gate</p>
      <h1 id="reload-panel-title" className="display reload-panel__title">
        {failure === 'chunk' ? 'Graumark has changed' : 'This screen stumbled'}
      </h1>
      <p className="reload-panel__text">
        {failure === 'chunk'
          ? 'A newer version went live while this page was open, and part of the town no longer loads. Reload to join it; your hero and your gold are safe on the server.'
          : 'Something went wrong while drawing this screen. Reload to try again; your hero and your gold are safe on the server.'}
      </p>
      <p className="reload-panel__actions">
        <button type="button" className="btn btn--brass" onClick={reload}>
          Reload
        </button>
        {town ? (
          <a className="reload-panel__town" href={routeHref('hub')}>
            Back to town
          </a>
        ) : null}
      </p>
    </section>
  );
}
