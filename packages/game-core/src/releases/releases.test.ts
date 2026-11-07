import { describe, expect, it } from 'vitest';
import { GAME_VERSION, PATCH_NOTES } from './notes.js';
import { compareVersions, isNewerVersion, parseVersion } from './version.js';

// Ticket F.3: the patch notes are the one source of the game's version. These checks keep the
// list well-formed as every player-visible PR adds an entry (CLAUDE.md, docs/DEVELOPMENT.md).
describe('patch notes', () => {
  it('has valid 0.<phase>.<patch> versions', () => {
    for (const note of PATCH_NOTES) {
      const v = parseVersion(note.version);
      expect(v, note.version).not.toBeNull();
      expect(v!.major, note.version).toBe(0);
    }
  });

  it('lists versions newest first, strictly increasing over time and unique', () => {
    const versions = PATCH_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < PATCH_NOTES.length; i++) {
      const newer = PATCH_NOTES[i - 1]!.version;
      const older = PATCH_NOTES[i]!.version;
      expect(compareVersions(older, newer), `${older} before ${newer}`).toBeLessThan(0);
    }
  });

  it('has real dates that never go backwards', () => {
    for (const note of PATCH_NOTES) {
      expect(note.date, note.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${note.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(note.date);
    }
    for (let i = 1; i < PATCH_NOTES.length; i++) {
      expect(PATCH_NOTES[i]!.date <= PATCH_NOTES[i - 1]!.date, PATCH_NOTES[i]!.version).toBe(true);
    }
  });

  it('ends at the exported current version', () => {
    expect(PATCH_NOTES[0]?.version).toBe(GAME_VERSION);
  });

  it('gives every release a title and at least one entry', () => {
    for (const note of PATCH_NOTES) {
      expect(note.title.trim(), note.version).not.toBe('');
      const entries = [...(note.new ?? []), ...(note.changed ?? []), ...(note.fixed ?? [])];
      expect(entries.length, note.version).toBeGreaterThan(0);
      for (const e of entries) expect(e.trim(), note.version).not.toBe('');
    }
  });

  it('stays in player language (no file names, code or internal jargon)', () => {
    const jargon =
      /\.(ts|tsx|css|sql|json|md|mjs)\b|`|\b(PR|API|CSS|endpoint|migration|backend|frontend|refactor|game-core|PGlite|Postgres)\b|#\d+/i;
    for (const note of PATCH_NOTES) {
      for (const text of [
        note.title,
        ...(note.new ?? []),
        ...(note.changed ?? []),
        ...(note.fixed ?? []),
      ]) {
        expect(text, note.version).not.toMatch(jargon);
      }
    }
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch, numerically', () => {
    expect(compareVersions('0.5.2', '0.5.10')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.5.2', '0.5.2')).toBe(0);
  });

  it('counts an invalid version as older than any valid one', () => {
    expect(compareVersions('garbage', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '')).toBeGreaterThan(0);
    expect(compareVersions('x', 'y')).toBe(0);
    expect(parseVersion('0.05.1')).toBeNull();
    expect(parseVersion('0.5')).toBeNull();
  });
});

describe('isNewerVersion (ticket F.4)', () => {
  it('is true only for a strictly newer version', () => {
    expect(isNewerVersion('0.5.3', '0.5.2')).toBe(true);
    expect(isNewerVersion('0.6.0', '0.5.9')).toBe(true);
    expect(isNewerVersion('0.5.10', '0.5.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('is false for an equal or older version', () => {
    expect(isNewerVersion('0.5.2', '0.5.2')).toBe(false);
    expect(isNewerVersion('0.5.1', '0.5.2')).toBe(false);
    expect(isNewerVersion('0.4.9', '0.5.0')).toBe(false);
    expect(isNewerVersion('0.5.9', '0.5.10')).toBe(false);
  });

  it('is false for anything malformed, on either side', () => {
    for (const bad of [
      '',
      'garbage',
      '0.5',
      '0.5.3.1',
      'v0.5.3',
      '0.05.3',
      ' 0.5.3',
      '0.5.3-beta',
    ]) {
      expect(isNewerVersion(bad, '0.5.2'), bad).toBe(false);
    }
    for (const bad of [undefined, null, 53, {}, ['0.5.3']]) {
      expect(isNewerVersion(bad, '0.5.2')).toBe(false);
    }
    expect(isNewerVersion('0.5.3', 'garbage')).toBe(false);
  });
});
