import type { Profile } from '@xitter/api-contracts';

/**
 * An author with no profile row (bootstrap race, profile since deleted)
 * still renders: the placeholder validates against the profile contract,
 * so clients stay schema-clean. The profile page behind it 404s, which is
 * honest. Shared by every read model that hydrates authors (feed, search).
 */
export function profileOrPlaceholder(id: string, profiles: Map<string, Profile>): Profile {
  return (
    profiles.get(id) ?? {
      id,
      username: 'unknown',
      displayName: 'Unknown',
      bio: null,
      createdAt: new Date(0).toISOString(),
    }
  );
}
