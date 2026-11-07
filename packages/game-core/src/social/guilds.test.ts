import { describe, expect, it } from 'vitest';
import {
  GUILD_ACTIONS,
  GUILD_EMBLEMS,
  GUILD_EMBLEM_IDS,
  GUILD_LIMITS,
  GUILD_ROLES,
  GUILD_STANDINGS,
  GUILD_TARGETS,
  guildDecision,
  isGuildEmblem,
  isGuildTargetAction,
} from './guilds.js';
import { validatePlayerText } from './text.js';
import { REPORT_TARGET_KINDS } from './reports.js';
import { MODERATION_ACTIONS } from './roles.js';
import { MUTE_EXEMPT, SOCIAL_WRITE_ACTIONS } from './sanctions.js';

// The full matrix runs through the API in the server's `guild-permissions.test.ts`; these pin the
// rules every cell there is built from.
describe('guild rules (ticket 4.4)', () => {
  it('only the leader acts on officers; nobody acts on the leader or themselves', () => {
    for (const action of GUILD_ACTIONS.filter(isGuildTargetAction)) {
      for (const actor of GUILD_ROLES) {
        expect(guildDecision(actor, action, 'self')).toMatchObject({ code: 'cannot_target_self' });
        if (actor !== 'leader') {
          expect(guildDecision(actor, action, 'leader')).toMatchObject({ status: 403 });
        }
      }
      expect(guildDecision('officer', action, 'officer')).toMatchObject({ status: 403 });
    }
    expect(guildDecision('officer', 'kick', 'member')).toBe('allowed');
    expect(guildDecision('leader', 'kick', 'officer')).toBe('allowed');
    expect(guildDecision('officer', 'promote', 'member')).toMatchObject({ status: 403 });
  });

  it('every standing × action × target has an answer, and non-members are never let in', () => {
    for (const actor of GUILD_STANDINGS) {
      for (const action of GUILD_ACTIONS) {
        for (const target of GUILD_TARGETS) {
          const d = guildDecision(actor, action, isGuildTargetAction(action) ? target : undefined);
          expect(d === 'allowed' || [403, 404, 409, 422].includes(d.status)).toBe(true);
          if (actor === 'none' && d === 'allowed') {
            expect([
              'create',
              'apply',
              'acceptInvite',
              'cancelApplication',
              'declineInvite',
            ]).toContain(action);
          }
        }
      }
    }
  });

  it('the leader must hand over before leaving', () => {
    expect(guildDecision('leader', 'leave')).toMatchObject({ code: 'leader_must_hand_over' });
    expect(guildDecision('officer', 'leave')).toBe('allowed');
  });

  it('caps, emblems, text kinds, reports, moderation and social writes are wired', () => {
    expect(GUILD_LIMITS.members).toBe(30);
    expect(new Set(GUILD_EMBLEM_IDS).size).toBe(GUILD_EMBLEMS.length);
    expect(GUILD_EMBLEM_IDS.every(isGuildEmblem)).toBe(true);
    expect(isGuildEmblem('upload.png')).toBe(false);
    expect(validatePlayerText('guildName', 'The Ashen Wardens')).toMatchObject({ ok: true });
    expect(validatePlayerText('guildTag', 'ASH')).toMatchObject({ ok: true });
    expect(validatePlayerText('guildName', 'Moderator Guild')).toMatchObject({ ok: false });
    expect(REPORT_TARGET_KINDS.guild.hideable).toBe(false);
    expect(MODERATION_ACTIONS).toEqual(expect.arrayContaining(['renameGuild', 'disbandGuild']));
    expect(SOCIAL_WRITE_ACTIONS).toEqual(expect.arrayContaining(['guildCreate', 'guildInvite']));
    // Stepping away is never blocked by a mute; reaching someone is.
    expect(MUTE_EXEMPT).toEqual(expect.arrayContaining(['guildLeave', 'guildDeclineInvite']));
    expect(MUTE_EXEMPT).not.toContain('guildInvite');
    expect(MUTE_EXEMPT).not.toContain('guildApply');
    expect(MUTE_EXEMPT).not.toContain('guildCreate');
  });
});
