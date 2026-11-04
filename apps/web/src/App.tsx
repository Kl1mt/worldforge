import { AreaScreen } from './screens/AreaScreen';
import { CharacterScreen } from './screens/CharacterScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { Shell } from './shell/Shell';
import { useRoute } from './shell/useRoute';

export function App() {
  const route = useRoute();
  return (
    <Shell route={route}>
      {route === 'area' ? <AreaScreen /> : null}
      {route === 'character' ? <CharacterScreen /> : null}
      {route === 'inventory' ? <InventoryScreen /> : null}
    </Shell>
  );
}
