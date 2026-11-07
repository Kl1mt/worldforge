import { useOnboarding } from '../onboarding/OnboardingProvider';
import { NotesScreen } from './NotesScreen';

/** `#/notes` inside the game shell: the screen with what this player had read before. */
export function NotesRoute() {
  const { notesSeenBefore } = useOnboarding();
  return <NotesScreen seenBefore={notesSeenBefore} />;
}
