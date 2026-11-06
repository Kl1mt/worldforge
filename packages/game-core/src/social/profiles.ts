/**
 * Public profiles (ticket 4.2, docs/SOCIAL.md "Profiles"): who may see a player's profile.
 *
 * The owner picks a visibility; the server works out the viewer's relation to the owner and asks
 * `canViewProfile`. A profile the viewer may not see answers `404` (it does not exist for them),
 * so a hidden profile and a block look exactly like an unknown player.
 */
export const PROFILE_VISIBILITIES = ['public', 'friendsAndGuild', 'hidden'] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

export const PROFILE_VISIBILITY_LABELS: Record<ProfileVisibility, string> = {
  public: 'Everyone',
  friendsAndGuild: 'Friends and guild',
  hidden: 'Only me',
};

export function isProfileVisibility(value: unknown): value is ProfileVisibility {
  return typeof value === 'string' && (PROFILE_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * The viewer's relation to the profile's owner, from the viewer's side. Friends, requests and
 * blocks belong to ticket 4.3, guilds to 4.4; the server maps their relation model onto this.
 * - `blocked`: either player blocked the other (a block hides each from the other everywhere).
 * - `pending`: a friend request in either direction, not yet accepted (not a friend).
 */
export const PROFILE_RELATIONS = [
  'self',
  'friend',
  'guildmate',
  'pending',
  'stranger',
  'blocked',
] as const;
export type ProfileRelation = (typeof PROFILE_RELATIONS)[number];

/** Whether a viewer with `relation` may see a profile with `visibility`. */
export function canViewProfile(visibility: ProfileVisibility, relation: ProfileRelation): boolean {
  if (relation === 'self') return true;
  if (relation === 'blocked') return false;
  switch (visibility) {
    case 'public':
      return true;
    case 'friendsAndGuild':
      return relation === 'friend' || relation === 'guildmate';
    case 'hidden':
      return false;
  }
}
