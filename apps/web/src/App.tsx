import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { guardRoute, isGameRoute, routeHref } from './lib/route';
import { AreaScreen } from './screens/AreaScreen';
import { AuthScreen, GateStatus } from './screens/AuthScreen';
import { CharacterScreen } from './screens/CharacterScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { Shell } from './shell/Shell';
import { useRoute } from './shell/useRoute';

export function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}

function Routes() {
  const route = useRoute();
  const auth = useAuth();
  const known = auth.state.kind === 'authenticated' || auth.state.kind === 'anonymous';
  const redirect = known ? guardRoute(route, auth.state.kind === 'authenticated') : null;

  useEffect(() => {
    // `replace` so the guarded screen does not stay in history behind the gate.
    if (redirect) window.location.replace(routeHref(redirect));
  }, [redirect]);

  if (auth.state.kind === 'loading' || redirect) return <GateStatus kind="checking" />;
  if (auth.state.kind === 'error') return <GateStatus kind="offline" onRetry={auth.retry} />;
  if (!isGameRoute(route)) return <AuthScreen mode={route} />;

  return (
    <Shell route={route}>
      {route === 'area' ? <AreaScreen /> : null}
      {route === 'character' ? <CharacterScreen /> : null}
      {route === 'inventory' ? <InventoryScreen /> : null}
    </Shell>
  );
}
