import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CharactersProvider, useCharacters } from './characters/CharactersProvider';
import { GameProvider } from './game/GameProvider';
import {
  DEFAULT_ROUTE,
  guardRoute,
  inviteFromLocation,
  isGameRoute,
  isLegalRoute,
  registerHref,
  routeHref,
  type Standing,
} from './lib/route';
import { LegalScreen } from './legal/LegalScreen';
import { AreaScreen } from './screens/AreaScreen';
import { AuthScreen, GateStatus, SuspendedGate } from './screens/AuthScreen';
import { AccountScreen } from './screens/AccountScreen';
import { AdminScreen } from './screens/AdminScreen';
import { ModerationScreen } from './screens/ModerationScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { FriendsScreen } from './screens/FriendsScreen';
import { GuildScreen } from './screens/GuildScreen';
import { WorksScreen } from './screens/WorksScreen';
import { WarehouseScreen } from './screens/WarehouseScreen';
import { BoardsScreen } from './screens/BoardsScreen';
import { NotesRoute } from './notes/NotesRoute';
import { isStaff } from '@worldforge/game-core';
import { TavernScreen } from './screens/TavernScreen';
import { CharacterScreen } from './screens/CharacterScreen';
import { CharactersScreen } from './screens/CharactersScreen';
import { CryptScreen, WatchScreen } from './screens/CryptScreen';
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
  // Ticket D.3: the admin panel likewise, for everyone but admins.
  const admin = auth.state.kind === 'authenticated' && auth.state.account.role === 'admin';
  const hidden = (route === 'moderation' && !staff) || (route === 'admin' && !admin);
  const redirect = standing
    ? (guardRoute(route, standing) ?? (hidden && standing === 'playing' ? DEFAULT_ROUTE : null))
    : null;
  // Ticket D.2: an invite link (`?invite=CODE`) opens the register screen for visitors, with the
  // code carried in the hash.
  const invite = inviteFromLocation(window.location.search, window.location.hash);
  const inviteRedirect =
    standing === 'anonymous' && invite && route !== 'register' && !isLegalRoute(route);

  useEffect(() => {
    // `replace` so the guarded screen does not stay in history behind the gate.
    if (inviteRedirect) {
      window.location.replace(`${window.location.pathname}${registerHref(invite)}`);
    } else if (redirect) window.location.replace(routeHref(redirect));
  }, [redirect, inviteRedirect, invite]);

  // Ticket D.2: the legal pages are open to everyone, whatever the session check says.
  if (isLegalRoute(route)) return <LegalScreen key={route} page={route} />;

  if (auth.state.kind === 'error') return <GateStatus kind="offline" onRetry={auth.retry} />;
  if (auth.state.kind === 'suspended') return <SuspendedGate sanction={auth.state.sanction} />;
  if (roster.state.kind === 'error') {
    return <GateStatus kind="roster-error" onRetry={roster.reload} />;
  }
  if (standing === null || redirect || inviteRedirect) return <GateStatus kind="checking" />;
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
            {route === 'watch' ? <WatchScreen /> : null}
            {route === 'tavern' ? <TavernScreen /> : null}
            {route === 'forge' ? <ForgeScreen /> : null}
            {route === 'merchant' ? <MerchantScreen /> : null}
            {route === 'character' ? <CharacterScreen /> : null}
            {route === 'inventory' ? <InventoryScreen /> : null}
            {route === 'account' ? <AccountScreen /> : null}
            {route === 'moderation' && staff ? <ModerationScreen /> : null}
            {route === 'admin' && admin ? <AdminScreen /> : null}
            {route === 'profile' ? <ProfileScreen /> : null}
            {route === 'friends' ? <FriendsScreen /> : null}
            {route === 'guild' ? <GuildScreen /> : null}
            {route === 'works' ? <WorksScreen /> : null}
            {route === 'warehouse' ? <WarehouseScreen /> : null}
            {route === 'boards' ? <BoardsScreen /> : null}
            {route === 'notes' ? <NotesRoute /> : null}
          </Shell>
        </OnboardingProvider>
      </QuestsProvider>
    </GameProvider>
  );
}
