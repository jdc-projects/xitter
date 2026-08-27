import { Anchor, AvatarGroup, Box, Group, Stack, ThemeIcon, Text, Title } from '@mantine/core';
import type { MantineColor } from '@mantine/core';
import {
  IconArrowsExchange,
  IconBrandNextjs,
  IconDatabase,
  IconRocket,
  IconServer,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { UserAvatar } from '@xitter/ui';

interface StackFact {
  icon: Icon;
  color: MantineColor;
  label: string;
  detail: string;
}

/**
 * "Under the hood" facts about the platform (#37). Facts about the product
 * live in code (spec 04 rule of thumb: prose about the site is CMS, the
 * product itself is code) - the CMS intro above stays the editable prose.
 */
const STACK_FACTS: StackFact[] = [
  {
    icon: IconBrandNextjs,
    color: 'dark',
    label: 'Next.js web app',
    detail: 'App Router SSR frontend, Mantine UI',
  },
  {
    icon: IconServer,
    color: 'indigo',
    label: '5 NestJS services',
    detail: 'social, posts, media, feed, search',
  },
  {
    icon: IconArrowsExchange,
    color: 'teal',
    label: '3 Kafka workers',
    detail: 'fanout, media-process, search-index',
  },
  {
    icon: IconDatabase,
    color: 'grape',
    label: 'Per-service storage',
    detail: 'Postgres, Kafka, OpenSearch, RustFS, Valkey',
  },
  {
    icon: IconRocket,
    color: 'orange',
    label: 'OpenTofu deploys',
    detail: 'declarative infrastructure on a home cluster',
  },
];

/**
 * The stack strip (#37): xitter is a portfolio piece and the landing page
 * says so - what it is, what it runs on, how it ships. Code-rendered so it
 * can never drift from the deployed reality.
 */
export function StackStrip() {
  return (
    <Stack gap="sm" data-testid="landing-stack">
      <Title order={2} size="h4">
        Under the hood
      </Title>
      <Text size="sm" c="dimmed">
        A microservices demo, end to end: a browser app, APIs with their own data, event-driven
        workers behind them, and infrastructure as code.{' '}
        <Anchor href="/about" size="sm" underline="always" data-testid="landing-stack-about-link">
          Read how it works
        </Anchor>
        .
      </Text>
      <Group justify="flex-start" align="flex-start" gap="lg" wrap="wrap">
        {STACK_FACTS.map((fact) => (
          <Stack key={fact.label} gap={4} miw={150} maw={230}>
            {/* Decorative glyph: aria-hidden so it is not exposed as an
                unnamed img in the a11y tree (audit #32). */}
            <ThemeIcon variant="light" color={fact.color} size="lg" radius="md" aria-hidden="true">
              <fact.icon size={20} stroke={1.75} />
            </ThemeIcon>
            <Text size="sm" fw={600}>
              {fact.label}
            </Text>
            <Text size="xs" c="dimmed">
              {fact.detail}
            </Text>
          </Stack>
        ))}
      </Group>
    </Stack>
  );
}

/**
 * Decorative hero motif (#37): the gradient avatars are xitter's visual
 * signature (one deterministic gradient per username), so the hero leans on
 * it. Purely decorative - hidden from assistive tech, no real profile data.
 */
export function LandingAvatarMotif() {
  return (
    <Box aria-hidden="true" data-testid="landing-avatars">
      <AvatarGroup>
        {['demo1', 'demo2', 'demo3', 'demo4', 'demo5'].map((username) => (
          <UserAvatar
            key={username}
            username={username}
            // Stand-ins for the demo accounts, not fetched profiles.
            displayName={username}
            size="md"
          />
        ))}
      </AvatarGroup>
    </Box>
  );
}
