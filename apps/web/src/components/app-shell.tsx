'use client';

import {
  ActionIcon,
  AppShell,
  Burger,
  Button,
  Container,
  Divider,
  Drawer,
  Group,
  NavLink,
  Stack,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBookmark, IconHome, IconInfoCircle, IconSearch } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { HeaderSearch } from './header-search';

// Decorative glyphs: the NavLink label / aria-label carries the meaning;
// without aria-hidden each svg surfaces as an unnamed img (audit #32).
const navIconProps = { size: 18, stroke: 1.75, 'aria-hidden': true } as const;

export interface AppShellFrameProps {
  /** Signed-in username; null renders the shell without user bits. */
  username: string | null;
  children: ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  /** Bookmarks is a session surface - hidden when signed out. */
  authenticated?: boolean;
}

/** Nav destinations shared by the header bar and the mobile drawer (#39). */
const NAV_ITEMS: NavItem[] = [
  { href: '/feed', label: 'Feed', icon: IconHome },
  { href: '/bookmarks', label: 'Bookmarks', icon: IconBookmark, authenticated: true },
  { href: '/about', label: 'About', icon: IconInfoCircle },
];

/** Active-page rule: exact match (query strings never reach usePathname). */
export function isNavActive(pathname: string | null, href: string): boolean {
  return pathname === href;
}

function navLink(item: NavItem, pathname: string | null, variant: 'header' | 'drawer'): ReactNode {
  const active = isNavActive(pathname, item.href);
  return (
    <NavLink
      key={item.href}
      component="a"
      href={item.href}
      label={item.label}
      leftSection={<item.icon {...navIconProps} />}
      active={active}
      aria-current={active ? 'page' : undefined}
      data-testid={`${variant}-nav-${item.label.toLowerCase()}`}
    />
  );
}

/**
 * Authenticated shell (#39): a Mantine AppShell header with icon'd,
 * active-marked NavLinks, a burger drawer with the same navigation (plus
 * Search) on small screens, and a header search icon so search stays
 * reachable below the xs breakpoint - it used to vanish entirely.
 */
export function AppShellFrame({ username, children }: AppShellFrameProps) {
  const pathname = usePathname();
  const [navOpened, { open: openNav, close: closeNav }] = useDisclosure(false);

  const visibleItems = NAV_ITEMS.filter((item) => !item.authenticated || username !== null);
  const searchActive = isNavActive(pathname, '/search');

  return (
    <AppShell header={{ height: 56 }}>
      <AppShell.Header>
        <Container size="md" h="100%">
          <Group h="100%" justify="space-between" wrap="nowrap" gap="sm" data-testid="app-nav">
            <Group gap="sm" wrap="nowrap">
              <Burger
                hiddenFrom="sm"
                opened={navOpened}
                onClick={navOpened ? closeNav : openNav}
                aria-label="Toggle navigation"
                data-testid="nav-burger"
              />
              <Text component="a" href="/feed" fw={700} inherit data-testid="app-brand">
                xitter
              </Text>
              <Group gap={0} wrap="nowrap" visibleFrom="sm">
                {visibleItems.map((item) => navLink(item, pathname, 'header'))}
              </Group>
            </Group>

            <Group gap="sm" wrap="nowrap">
              <HeaderSearch />
              {/* One-tap search below the xs breakpoint (#39: search must
                stay reachable on mobile even though the box is hidden). */}
              <ActionIcon
                component="a"
                href="/search"
                variant="default"
                aria-label="Search"
                hiddenFrom="xs"
                data-testid="mobile-search-link"
              >
                <IconSearch {...navIconProps} />
              </ActionIcon>
              {username ? (
                <>
                  <Text
                    size="sm"
                    c="dimmed"
                    inherit
                    component="a"
                    href={`/profile/${username}`}
                    data-testid="nav-username"
                  >
                    @{username}
                  </Text>
                  <form action="/api/auth/logout" method="post">
                    <Button size="xs" variant="subtle" type="submit" data-testid="logout-button">
                      Log out
                    </Button>
                  </form>
                </>
              ) : null}
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <Drawer
        opened={navOpened}
        onClose={closeNav}
        title={
          <Text component="a" href="/feed" fw={700} inherit>
            xitter
          </Text>
        }
        size="xs"
        padding="md"
        // Plain-anchor navigation reloads the document, but closing here
        // keeps the drawer well-behaved for the back button too.
        onClick={closeNav}
      >
        <Stack gap="xs">
          <NavLink
            component="a"
            href="/search"
            label="Search"
            leftSection={<IconSearch {...navIconProps} />}
            active={searchActive}
            aria-current={searchActive ? 'page' : undefined}
            data-testid="drawer-nav-search"
          />
          {visibleItems.map((item) => navLink(item, pathname, 'drawer'))}
          <Divider my={4} />
          {/* Public info stays reachable post-login (reset schedule, FAQ). */}
          <Text size="xs" c="dimmed">
            Demo data resets nightly.
          </Text>
        </Stack>
      </Drawer>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
