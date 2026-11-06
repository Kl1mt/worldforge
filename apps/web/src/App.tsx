import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CharactersProvider, useCharacters } from './characters/CharactersProvider';
import { GameProvider } from './game/GameProvider';
import { DEFAULT_ROUTE, guardRoute, isGameRoute, routeHref, type Standing } from './lib/route';
import { AreaScreen } from './screens/AreaScreen';
import { AuthScreen, GateStatus, SuspendedGate } from './screens/AuthScreen';
import { AccountScreen } from './screens/AccountScreen';
import { ModerationScreen } from './screens/ModerationScreen';
import { isStaff } from '@worldforge/game-core';
import { TavernScreen } from './screens/TavernScreen';
import { CharacterScreen } from './screens/CharacterScreen';
import { CharactersScreen } from './screens/CharactersScreen';
import { CryptScreen } from './screens/CryptScreen';
import { ForgeScreen } from './screens/ForgeScreen';
import { HubScreen } from './screens/HubScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { MapScreen } from './screens/MapScreen';
import { MerchantScreen } from './screens/MerchantScreen';
import { OnboardingProvider } from './onboarding/OnboardingProvider';
import { QuestsProvider } from './quests/useQuests';
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
  // Ticket 4.1: the moderator queue does not exist for players (like an unknown address).
  const staff = auth.state.kind === 'authenticated' && isStaff(auth.state.account.role);
  const redirect = standing
    ? (guardRoute(route, standing) ??
      (route === 'moderation' && standing === 'playing' && !staff ? DEFAULT_ROUTE : null))
    : null;

  useEffect(() => {
    // `replace` so the guarded screen does not stay in history behind the gate.
    if (redirect) window.location.replace(routeHref(redirect));
  }, [redirect]);

  if (auth.state.kind === 'error') return <GateStatus kind="offline" onRetry={auth.retry} />;
  if (auth.state.kind === 'suspended') return <SuspendedGate sanction={auth.state.sanction} />;
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
      <QuestsProvider characterId={active.id}>
        <OnboardingProvider route={route}>
          <Shell route={route}>
            {route === 'hub' ? <HubScreen /> : null}
            {route === 'map' ? <MapScreen /> : null}
            {route === 'area' ? <AreaScreen /> : null}
            {route === 'crypt' ? <CryptScreen /> : null}
            {route === 'tavern' ? <TavernScreen /> : null}
            {route === 'forge' ? <ForgeScreen /> : null}
            {route === 'merchant' ? <MerchantScreen /> : null}
            {route === 'character' ? <CharacterScreen /> : null}
            {route === 'inventory' ? <InventoryScreen /> : null}
            {route === 'account' ? <AccountScreen /> : null}
            {route === 'moderation' && staff ? <ModerationScreen /> : null}
          </Shell>
        </OnboardingProvider>
      </QuestsProvider>
    </GameProvider>
  );
}
