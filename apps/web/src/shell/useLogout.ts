import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

/** Logout with busy and error state, shared by the game shell and character select. */
export function useLogout() {
  const auth = useAuth();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logout = async () => {
    setLeaving(true);
    setError(null);
    const failure = await auth.logout();
    // On success the route guard sends the visitor to the gate and the caller unmounts.
    if (failure) {
      setLeaving(false);
      setError(
        failure.code === 'network'
          ? 'Could not log out: server unreachable.'
          : 'Could not log out.',
      );
    }
  };

  return { leaving, error, logout };
}
