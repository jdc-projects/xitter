import { Anchor, Container, Divider, List, Stack, Text, Title } from "@mantine/core";
import { ResetNotice } from "@xitter/ui";

export const metadata = { title: "About" };

const demoAccounts = "demo1 through demo10";
const demoPassword = "DemoPass123!";

export default function AboutPage() {
  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Title order={1}>About</Title>

        <section>
          <Title order={2} size="h4">
            What is this?
          </Title>
          <Text>
            xitter is a small Twitter/X-style demo application: text and image posts, a feed of the
            people you follow, replies, likes, bookmarks, reposts, and the ability to follow or block
            other accounts.
          </Text>
        </section>

        <section>
          <Title order={2} size="h4">
            Why does it exist?
          </Title>
          <Text>
            It is a playground for building and demonstrating a realistic microservices system -
            service decomposition, event-driven workers, infrastructure as code, testing and
            observability - on a home Kubernetes cluster, without any real users or data at stake.
          </Text>
        </section>

        <section>
          <Title order={2} size="h4">
            How does it work?
          </Title>
          <Text>
            A Next.js frontend talks to a set of backend APIs (profiles and relationships, posts and
            interactions, media, feed, search). Events flow through Kafka to workers that build
            feeds and search indices. Content is stored in per-service databases and an object
            store. Login uses demo accounts only - there is no signup and no account management.
          </Text>
        </section>

        <Divider />

        <section>
          <Title order={2} size="h4">
            Data resets
          </Title>
          <ResetNotice aboutHref="/about" compact />
          <List mt="sm" withPadding>
            <List.Item>When: every night at 00:00 UTC.</List.Item>
            <List.Item>
              What: everything - posts, follows, media, search indices, messages, and demo account
              sessions. Accounts are restored to their original state, with original passwords.
            </List.Item>
            <List.Item>
              What survives: nothing user-generated. Site content and code changes live in the
              repository, not the environment.
            </List.Item>
          </List>
        </section>

        <section>
          <Title order={2} size="h4">
            Demo accounts
          </Title>
          <Text>
            Log in with any of {demoAccounts}, password {demoPassword}. All accounts are equivalent.
            See the login page for details.
          </Text>
        </section>

        <section>
          <Title order={2} size="h4">
            FAQ
          </Title>
          <Stack gap="xs">
            <Text>
              <b>Can I sign up?</b> No. Only the pre-created demo accounts exist.
            </Text>
            <Text>
              <b>Is my data private?</b> No. Anyone with a demo account can see everything, and it
              is all deleted nightly. Never enter personal or sensitive information.
            </Text>
            <Text>
              <b>Something broke / looks wrong.</b> That is part of the fun of a demo - it may also
              be mid-reset. Check back a few minutes later.
            </Text>
          </Stack>
        </section>

        <Divider />

        <Text size="sm" c="dimmed">
          Unauthenticated visitors cannot see posts or users -{" "}
          <Anchor href="/login">log in</Anchor> to look around.
        </Text>
      </Stack>
    </Container>
  );
}
