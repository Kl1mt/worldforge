import { describe, expect, it } from 'vitest';
import {
  PROFILE_RELATIONS,
  PROFILE_VISIBILITIES,
  canViewProfile,
  type ProfileRelation,
  type ProfileVisibility,
} from './profiles.js';

describe('canViewProfile (ticket 4.2)', () => {
  // Written out by hand so a rule change has to change this table.
  const expected: Record<ProfileVisibility, Record<ProfileRelation, boolean>> = {
    public: {
      self: true,
      friend: true,
      guildmate: true,
      pending: true,
      stranger: true,
      blocked: false,
    },
    friendsAndGuild: {
      self: true,
      friend: true,
      guildmate: true,
      pending: false,
      stranger: false,
      blocked: false,
    },
    hidden: {
      self: true,
      friend: false,
      guildmate: false,
      pending: false,
      stranger: false,
      blocked: false,
    },
  };

  for (const visibility of PROFILE_VISIBILITIES) {
    for (const relation of PROFILE_RELATIONS) {
      it(`${visibility} × ${relation}`, () => {
        expect(canViewProfile(visibility, relation)).toBe(expected[visibility][relation]);
      });
    }
  }
});
