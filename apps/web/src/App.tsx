import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CharactersProvider, useCharacters } from './characters/CharactersProvider';
import { GameProvider } from './game/GameProvider';
import { guardRoute, isGameRoute, routeHref, type Standing } from './lib/route';
import { AreaScreen } from './screens/AreaScreen';
import { AuthScreen, GateStatus } from './screens/AuthScreen';
import { BuildingScreen } from './screens/BuildingScreen';
import { CharacterScreen } from './screens/CharacterScreen';
import { CharactersScreen } from './screens/CharactersScreen';
import { HubScreen } from './screens/HubScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { MapScreen } from './screens/MapScreen';
import { Shell } from './shell/Shell';
import { useRoute } from './shell/useRoute';

export function App() {
  return (
    <AuthProvider>
      <CharactersProvider>
        <Routes />
      </CharactersProvider>
    </AuthProvider>
  );
}

function Routes() {
  const route = useRoute();
  const auth = useAuth();
  const roster = useCharacters();

  // `null` while we do not know yet (session check or roster still loading, or failed).
  let standing: Standing | null = null;
  if (auth.state.kind === 'anonymous') standing = 'anonymous';
  else if (auth.state.kind === 'authenticated' && roster.state.kind === 'ready') {
    standing = roster.active ? 'playing' : 'account';
  }
  const redirect = standing ? guardRoute(route, standing) : null;

  useEffect(() => {
    // `replace` so the guarded screen does not stay in history behind the gate.
    if (redirect) window.location.replace(routeHref(redirect));
  }, [redirect]);

  if (auth.state.kind === 'error') return <GateStatus kind="offline" onRetry={auth.retry} />;
  if (roster.state.kind === 'error') {
    return <GateStatus kind="roster-error" onRetry={roster.reload} />;
  }
  if (standing === null || redirect) return <GateStatus kind="checking" />;
  if (route === 'characters') return <CharactersScreen />;
  if (!isGameRoute(route)) return <AuthScreen mode={route} />;

  // The guard guarantees an active character here. Keyed by it, so switching heroes starts
  // from fresh game state.
  const active = roster.active!;
  return (
    <GameProvider key={active.id} character={active}>
      <Shell route={route}>
        {route === 'hub' ? <HubScreen /> : null}
        {route === 'map' ? <MapScreen /> : null}
        {route === 'area' ? <AreaScreen /> : null}
        {route === 'tavern' || route === 'forge' || route === 'merchant' ? (
          <BuildingScreen building={route} />
        ) : null}
        {route === 'character' ? <CharacterScreen /> : null}
        {route === 'inventory' ? <InventoryScreen /> : null}
      </Shell>
    </GameProvider>
  );
}
