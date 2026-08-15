import { Button, Container, Group, Stack, Text, Title } from "@mantine/core";
import Link from "next/link";
import { ResetNotice } from "@xitter/ui";

export default function LandingPage() {
  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Title order={1}>xitter</Title>
        <Text size="lg" c="dimmed">
          A small Twitter/X-style demo app: posts, follows, replies, likes, bookmarks and reposts -
          built as a microservices playground for learning and experimentation.
        </Text>

        <ResetNotice />

        <Group>
          <Button component={Link} href="/login" size="md">
            Log in with a demo account
          </Button>
          <Button component={Link} href="/about" variant="subtle" size="md">
            About
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
