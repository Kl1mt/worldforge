/**
 * Ticket 6.9: letters for generated test names that never look alike under game-core's
 * `nameSkeleton` (no `i`/`l`, which read the same, no `r` (`rn` reads as `m`) and no `v` (`vv` reads
 * as `w`)), so two generated names are never refused as look-alikes of each other, and that can't
 * spell a short blocked or reserved word (no `c`, `k`, `m`, `s`: `gm`, `mod`, `ass`, `kys`, …).
 */
export const NAME_SAFE_LETTERS = 'abdefghjnopqtuwxyz';

/** `n` spelled in `NAME_SAFE_LETTERS` (0 → "a"). */
export function safeLetters(n: number): string {
  const b = NAME_SAFE_LETTERS.length;
  let s = '';
  do {
    s = NAME_SAFE_LETTERS[n % b]! + s;
    n = Math.floor(n / b);
  } while (n > 0);
  return s;
}
