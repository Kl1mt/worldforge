import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useMailEnabled } from '../auth/useMailEnabled';
import { routeHref, type GameRoute } from '../lib/route';
import '../screens/security.css';

const LATER_KEY = 'wf.verify.later';

/** Whether "Later" was chosen in this tab for this account (sessionStorage; never a migration). */
function laterChosen(accountId: string): boolean {
  try {
    return window.sessionStorage.getItem(LATER_KEY) === accountId;
  } catch {
    return false;
  }
}

/**
 * Ticket 5.7: a quiet strip on every game screen while the account's email is unverified and the
 * server can send mail. "Later" hides it for the rest of the tab's session. Unverified accounts
 * play normally; the strip only points to the account screen.
 */
export function VerifyStrip({ route }: { route: GameRoute }) {
  const auth = useAuth();
  const mail = useMailEnabled();
  const account = auth.state.kind === 'authenticated' ? auth.state.account : null;
  const [later, setLater] = useState(() => (account ? laterChosen(account.id) : false));
  if (!account || account.emailVerified || mail !== true || later || route === 'account') {
    return null;
  }
  return (
    <p className="acct-verify-strip">
      <span>
        <strong>Your email is not verified yet.</strong> Confirm it so you can always get back into
        your account.
      </span>
      <a href={routeHref('account')}>Verify it</a>
      <button
        type="button"
        className="acct-verify-strip__later"
        onClick={() => {
          try {
            window.sessionStorage.setItem(LATER_KEY, account.id);
          } catch {
            /* storage off: hide for this page only */
          }
          setLater(true);
        }}
      >
        Later
      </button>
    </p>
  );
}
