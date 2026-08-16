import { Container, Stack, Text, Title } from '@mantine/core';
import { requireSession } from '@/lib/auth/session';

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  await requireSession(`/profile/${username}`);
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1}>@{username}</Title>
        {/* Profile: bio, follow/block actions, posts, following and follower lists. */}
        <Text size="sm" c="dimmed" data-testid="profile-placeholder">
          Profile placeholder - profile details land with the profile feature ticket.
        </Text>
      </Stack>
    </Container>
  );
}
