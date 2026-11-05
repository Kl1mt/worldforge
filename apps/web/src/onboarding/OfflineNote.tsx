import { useGame } from '../game/GameProvider';
import { capText } from './guide';
import './onboarding.css';

/**
 * "What continues while you're away" (GDD §9.2, ticket 2.7). The cap is the server's
 * configured value; until it is known the note says "a few hours".
 */
export function OfflineNote({ open = false }: { open?: boolean }) {
  const { offlineCapMs } = useGame();
  const cap = offlineCapMs !== null ? capText(offlineCapMs) : 'a few hours';
  return (
    <details className="offline" open={open}>
      <summary className="offline__summary">What continues while you are away</summary>
      <div className="offline__body">
        <div>
          <h3 className="caps offline__head offline__head--on">Carries on</h3>
          <ul>
            <li>
              Farming in the chosen area, for up to <strong>{cap}</strong>: foes, XP, gold, drops
              and materials.
            </li>
            <li>Quest and contract progress from those fights.</li>
            <li>A crypt run already under way plays out; claim it when you are back.</li>
          </ul>
        </div>
        <div>
          <h3 className="caps offline__head offline__head--off">Needs you here</h3>
          <ul>
            <li>Equipping drops, the Forge and the Merchant.</li>
            <li>Taking and turning in quests at the Tavern.</li>
            <li>Choosing a new area, starting a crypt run.</li>
            <li>Time beyond {cap} away is not counted.</li>
          </ul>
        </div>
      </div>
    </details>
  );
}
