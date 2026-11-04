import { useEffect, useState } from 'react';

const matches = (query: string) =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;

/** Tracks a CSS media query, e.g. the phone breakpoint, for choosing pixel-art scales. */
export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatch(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return match;
}
