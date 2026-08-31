import { Anchor, Group } from '@mantine/core';

export interface ProfileTabsProps {
  active: string;
  profile: { username: string };
  counts: { following: number; followers: number };
}

/**
 * Profile list tabs (#4): text tabs, the active one heavier. The anchors
 * must keep Mantine's Anchor class (#200): `unstyled` drops its colour rule
 * and nothing else resets `a` colours, so the tabs fell through to the
 * browser's default blue/purple link palette. Explicit `c` keeps every tab
 * text-coloured in both colour schemes; `underline="never"` preserves the
 * plain text-tab look.
 */
export function ProfileTabs({ active, profile, counts }: ProfileTabsProps) {
  const tabs = [
    { value: 'posts', label: 'Posts', href: `/profile/${profile.username}` },
    {
      value: 'following',
      label: `Following ${counts.following}`,
      href: `/profile/${profile.username}?tab=following`,
    },
    {
      value: 'followers',
      label: `Followers ${counts.followers}`,
      href: `/profile/${profile.username}?tab=followers`,
    },
  ];
  return (
    <Group gap={0} mb="md" data-testid="profile-tabs">
      {tabs.map((t) => (
        <Anchor
          key={t.value}
          href={t.href}
          px="sm"
          py="xs"
          underline="never"
          c={t.value === active ? 'var(--mantine-color-text)' : 'dimmed'}
          fw={t.value === active ? 600 : 400}
          aria-current={t.value === active ? 'page' : undefined}
          data-testid={`tab-${t.value}`}
        >
          {t.label}
        </Anchor>
      ))}
    </Group>
  );
}
