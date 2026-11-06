/**
 * Block list for player-written text (ticket 4.1, docs/SOCIAL.md "Player text"). Data, not code:
 * the owner extends these lists without touching the matcher. Every term is compared after the
 * same "skeleton" folding as the text (case, accents, look-alike letters, leetspeak, repeated
 * letters and separators), so write terms in plain lowercase letters.
 *
 * - `anywhere`: blocked wherever its letters appear, even across separators ("f.u.c.k") or inside a
 *   longer word ("xfuckx"). Only for terms that are never part of an innocent word.
 * - `word`: blocked as a whole word (with common suffixes such as -s, -er, -ing), so innocent words
 *   that contain it pass ("class", "assassin", "Scunthorpe").
 */
export type BlockMatch = 'anywhere' | 'word';

export interface BlockedTerm {
  term: string;
  match: BlockMatch;
}

/** Profanity and slurs, for every kind that filters (`PLAYER_TEXT_RULES[kind].blockList`). */
export const BLOCKED_TERMS: readonly BlockedTerm[] = [
  { term: 'fuck', match: 'anywhere' },
  { term: 'motherfucker', match: 'anywhere' },
  { term: 'nigger', match: 'anywhere' },
  { term: 'nigga', match: 'anywhere' },
  { term: 'faggot', match: 'anywhere' },
  { term: 'retard', match: 'word' },
  { term: 'kike', match: 'word' },
  { term: 'spic', match: 'word' },
  { term: 'chink', match: 'word' },
  { term: 'tranny', match: 'word' },
  { term: 'whore', match: 'word' },
  { term: 'slut', match: 'word' },
  { term: 'cunt', match: 'word' },
  { term: 'shit', match: 'word' },
  { term: 'bullshit', match: 'word' },
  { term: 'bitch', match: 'word' },
  { term: 'bastard', match: 'word' },
  { term: 'dick', match: 'word' },
  { term: 'cock', match: 'word' },
  { term: 'pussy', match: 'word' },
  { term: 'ass', match: 'word' },
  { term: 'asshole', match: 'word' },
  { term: 'rape', match: 'word' },
  { term: 'rapist', match: 'word' },
  { term: 'nazi', match: 'word' },
  { term: 'hitler', match: 'anywhere' },
  { term: 'kys', match: 'word' },
  { term: 'killyourself', match: 'anywhere' },
];

/**
 * Names that could pass for staff or the game itself; only for name kinds
 * (`PLAYER_TEXT_RULES[kind].reserved`).
 */
export const RESERVED_NAME_TERMS: readonly BlockedTerm[] = [
  { term: 'admin', match: 'anywhere' },
  { term: 'administrator', match: 'anywhere' },
  { term: 'moderator', match: 'anywhere' },
  { term: 'mod', match: 'word' },
  { term: 'gm', match: 'word' },
  { term: 'gamemaster', match: 'anywhere' },
  { term: 'staff', match: 'word' },
  { term: 'support', match: 'word' },
  { term: 'official', match: 'word' },
  { term: 'system', match: 'word' },
  { term: 'worldforge', match: 'anywhere' },
];
