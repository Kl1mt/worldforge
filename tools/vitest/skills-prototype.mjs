/**
 * Ticket 9.1: the default-loadout replay, a Vitest setup file for game-core.
 *
 * With `WF_SKILLS_PROTOTYPE=shadow` every test file runs with the skills prototype on in shadow
 * mode: each fight carries the default loadout's kit and is resolved again with today's rules;
 * any difference throws (`SkillsReplayMismatch`), so every pinned hash and band of the existing
 * suites is checked against the kit path. `WF_SKILLS_PROTOTYPE=on` runs the kit path alone.
 * Without the variable it does nothing: the switch stays off.
 */
import { setSkillsPrototype } from '../../packages/game-core/src/combat/kit.ts';

const mode = process.env.WF_SKILLS_PROTOTYPE;
if (mode) setSkillsPrototype(mode);
