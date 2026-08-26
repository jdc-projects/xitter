'use client';

import { Anchor, Box, Button, Container, Group, Text } from '@mantine/core';
import { usePathname } from 'next/navigation';
import { UserAvatar } from '@xitter/ui';

export interface PublicHeaderProps {
  /** Signed-in username (#38): swaps Log in for the handle + a feed link. */
  username: string | null;
}

/** Active-page rule, same as the app shell: exact match. */
export function isNavCurrent(pathname: string | null, href: string): boolean {
  return pathname === href;
}

/**
 * Nav shared by the public pages (landing, About) so visitors can always
 * move between home, About and login (spec 02 §1.5). When the page passes a
 * resolved session, the Log in CTA becomes the visitor's handle and a way
 * back into the app (#38) - the authenticated shell still renders its own
 * nav, never this header. Links mark the current page (aria-current).
 */
export function PublicHeader({ username }: PublicHeaderProps) {
  const pathname = usePathname();
  const aboutCurrent = isNavCurrent(pathname, '/about');

  return (
    <Box component="header" mb="lg" data-testid="public-header">
      <Container size="sm">
        <Group justify="space-between" py="sm" wrap="nowrap">
          <Text
            component="a"
            href="/"
            fw={700}
            inherit
            aria-current={isNavCurrent(pathname, '/') ? 'page' : undefined}
            data-testid="public-brand"
          >
            xitter
          </Text>
          <Group gap="md" wrap="nowrap">
            <Anchor
              href="/about"
              size="sm"
              c="dimmed"
              fw={aboutCurrent ? 600 : 400}
              underline={aboutCurrent ? 'always' : undefined}
              aria-current={aboutCurrent ? 'page' : undefined}
              data-testid="public-about-link"
            >
              About
            </Anchor>
            {username ? (
              <Group gap="sm" wrap="nowrap">
                <Anchor
                  href={`/profile/${username}`}
                  underline="never"
                  aria-label={`@${username}`}
                  data-testid="public-profile-link"
                >
                  <Group gap={6} wrap="nowrap">
                    <UserAvatar username={username} displayName={username} size="sm" />
                    <Text size="sm" c="dimmed" inherit>
                      @{username}
                    </Text>
                  </Group>
                </Anchor>
                <Button
                  component="a"
                  href="/feed"
                  size="xs"
                  variant="light"
                  data-testid="public-feed-link"
                >
                  Back to the feed
                </Button>
              </Group>
            ) : (
              <Button
                component="a"
                href="/login"
                size="xs"
                variant="light"
                data-testid="public-login-link"
              >
                Log in
              </Button>
            )}
          </Group>
        </Group>
      </Container>
    </Box>
  );
}
