import { describe, expect, it } from 'vitest';
import {
  RESERVED_NAME_DEFAULTS,
  matchesReservedName,
  nameSkeleton,
  namesLookAlike,
  reservedNameMatch,
} from './names.js';

describe('nameSkeleton (ticket 6.9)', () => {
  it('reads accents, digits, case and other scripts as the letters they imitate', () => {
    for (const n of [
      'Admin',
      'ADMIN',
      'Admín',
      'Adm1n',
      'ADMlN',
      'Аdmin',
      'ΑDΜΙΝ',
      'adm!n',
      'A d m i n',
    ])
      expect(nameSkeleton(n), n).toBe('admin');
  });

  it('folds look-alikes of other players', () => {
    expect(namesLookAlike('Alice', 'Аlice')).toBe(true); // Cyrillic а
    expect(namesLookAlike('Alice', 'AIice')).toBe(true); // capital I for l
    expect(namesLookAlike('Marn', 'Mam')).toBe(true); // rn reads as m
    expect(namesLookAlike('Wolf', 'VVolf')).toBe(true);
    expect(namesLookAlike('Bo0k', 'Book')).toBe(true);
    expect(namesLookAlike('Ｂｏｒｉｓ', 'Boris')).toBe(true); // full-width
    expect(namesLookAlike('Bo​ris', 'Boris')).toBe(true); // zero-width space
    expect(namesLookAlike('Mael-Dun', "Mael'Dun")).toBe(true);
  });

  it('keeps different names apart', () => {
    expect(namesLookAlike('Alice', 'Alicia')).toBe(false);
    expect(namesLookAlike('Edric', 'Cedric')).toBe(false);
    expect(namesLookAlike('Anna', 'Ana')).toBe(false);
    expect(namesLookAlike('さくら', 'Sakura')).toBe(false);
    expect(nameSkeleton('さくら')).toBe('さくら');
  });
});

describe('reserved names (ticket 6.9)', () => {
  it('has staff, every boss and the town people built in', () => {
    const names = RESERVED_NAME_DEFAULTS.map((d) => d.name);
    for (const n of [
      'Admin',
      'Moderator',
      'Gravewarden',
      'Ashen Warden',
      'Forge Tyrant',
      'Risen Gravewarden',
      'Old Reeve Hadric',
      'Captain Ysolde',
    ])
      expect(names).toContain(n);
    expect(names).not.toContain('Maud');
  });

  it('matches look-alikes, whole words and long names inside words', () => {
    expect(reservedNameMatch('Adm1n')).toBe('Admin');
    expect(reservedNameMatch('The Gravewarden')).toBe('Gravewarden');
    expect(reservedNameMatch('TheGravewarden')).toBe('Gravewarden');
    expect(reservedNameMatch('Captain Ysolde II')).toBe('Captain Ysolde');
    expect(reservedNameMatch('Аshen Wаrden')).toBe('Ashen Warden');
    expect(reservedNameMatch('Maud')).toBeNull();
    expect(reservedNameMatch('Edric')).toBeNull();
    expect(reservedNameMatch('Warden Fan')).toBeNull();
    expect(reservedNameMatch('Ashen Wardens')).toBeNull();
  });

  it('takes extra names from the store', () => {
    expect(reservedNameMatch('Kestrel', ['Kestrel'])).toBe('Kestrel');
    expect(reservedNameMatch('KestreI the Bold', ['Kestrel'])).toBe('Kestrel');
    expect(matchesReservedName('Kes', 'Kestrel')).toBe(false);
  });
});
