import { useEffect, useState } from 'react';
import { NOTICE_MS, useOnboarding } from './OnboardingProvider';
import { orderNotices, type Notice } from './notices';
import './onboarding.css';

const KIND_LABEL: Record<Notice['kind'], string> = {
  level: 'Level up',
  unlock: 'A road opens',
  quest: 'Quest',
  world: 'Graumark',
};

/** Progression notices (ticket 2.7): small herald slips under the top bar that fade. */
export function Notices() {
  const { notices, dismissNotice } = useOnboarding();
  return (
    <section className="notices" aria-label="Notices" aria-live="polite">
      {notices.length > 0 ? (
        <ul className="notices__list">
          {orderNotices(notices).map((n) => (
            <NoticeSlip key={n.id} notice={n} dismiss={dismissNotice} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function NoticeSlip({ notice, dismiss }: { notice: Notice; dismiss: (id: string) => void }) {
  // Paused while the pointer or focus is on it, so it never vanishes mid-read. The timer only
  // restarts when that changes (`dismiss` is stable), not on every render of the shell.
  const [held, setHeld] = useState(false);
  const { id } = notice;
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => dismiss(id), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [held, id, dismiss]);
  const onDismiss = () => dismiss(id);
  return (
    <li
      className={`notice notice--${notice.kind}`}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <p className="caps notice__kind">{KIND_LABEL[notice.kind]}</p>
      <p className="notice__title display">{notice.title}</p>
      <p className="notice__text">{notice.text}</p>
      {notice.href ? (
        <a className="notice__link" href={notice.href} onClick={onDismiss}>
          {notice.linkLabel ?? 'Go'}
        </a>
      ) : null}
      <button
        type="button"
        className="notice__close"
        onClick={onDismiss}
        aria-label={`Dismiss: ${notice.title}`}
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}
