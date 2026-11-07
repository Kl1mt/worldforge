import { describe, expect, it } from 'vitest';
import { GUILD_CHAT_LIMITS, guildChatDecision } from './guild-chat.js';
import { REPORT_TARGET_KINDS } from './reports.js';
import { MUTE_EXEMPT, blockingSanction } from './sanctions.js';
import { validatePlayerText } from './text.js';

describe('guild chat rules (ticket 4.5)', () => {
  it('removing lines follows rank; the notice is for officers and the leader', () => {
    expect(guildChatDecision('member', 'delete', 'self')).toBe('allowed');
    expect(guildChatDecision('member', 'delete', 'member')).toMatchObject({ status: 403 });
    expect(guildChatDecision('officer', 'delete', 'member')).toBe('allowed');
    expect(guildChatDecision('officer', 'delete', 'none')).toBe('allowed');
    expect(guildChatDecision('officer', 'delete', 'officer')).toMatchObject({ status: 403 });
    expect(guildChatDecision('officer', 'delete', 'leader')).toMatchObject({ status: 403 });
    expect(guildChatDecision('leader', 'delete', 'officer')).toBe('allowed');
    expect(guildChatDecision('none', 'read')).toMatchObject({ status: 404, code: 'not_in_guild' });
    expect(guildChatDecision('member', 'setNotice')).toMatchObject({ code: 'guild_forbidden' });
    expect(guildChatDecision('officer', 'setNotice')).toBe('allowed');
  });

  it('messages are hideable report targets; a mute blocks posting but not removing', () => {
    expect(REPORT_TARGET_KINDS.message.hideable).toBe(true);
    const mute = { kind: 'mute' as const };
    expect(blockingSanction([mute], 'chat')).toBe(mute);
    expect(blockingSanction([mute], 'guildNotice')).toBe(mute);
    expect(MUTE_EXEMPT).toContain('chatDelete');
  });

  it('a notice keeps line breaks, filters words and refuses links', () => {
    expect(validatePlayerText('guildNotice', 'Raid at dusk.\n\n\n\nBring torches.')).toEqual({
      ok: true,
      value: 'Raid at dusk.\n\nBring torches.',
    });
    expect(validatePlayerText('guildNotice', 'see discord.gg/abc')).toMatchObject({
      problem: 'link',
    });
    expect(validatePlayerText('guildNotice', 'x'.repeat(401))).toMatchObject({
      problem: 'too_long',
    });
    // A full guild posting at the social-write limit (12 a minute each) between two polls stays
    // under one poll's lines, so a polling client never falls behind.
    const perPoll = 30 * 12 * (GUILD_CHAT_LIMITS.pollVisibleMs / 60_000);
    expect(perPoll).toBe(30);
    expect(perPoll).toBeLessThan(GUILD_CHAT_LIMITS.pollMax);
  });
});
