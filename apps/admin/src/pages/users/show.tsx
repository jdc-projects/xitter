import { Card, List, Space, Typography } from 'antd';
import { useOne } from '@refinedev/core';
import { useParams } from 'react-router';
import type { AdminFollowGraph } from '@xitter/api-contracts';

/**
 * User inspection: profile + graph counts + both directions of the follow
 * graph. Read-only - the panel mutates no user content (AC 11.3).
 */
export function UsersShowPage() {
  const { id } = useParams();
  // The users resource's "record" is the follow-graph view (see provider).
  const { query } = useOne<AdminFollowGraph & { id?: string }>({
    resource: 'users',
    id: id ?? '',
  });
  const graph = query.data?.data;

  if (query.isLoading) return <Typography.Text>Loading…</Typography.Text>;
  if (!graph) return <Typography.Text>User not found.</Typography.Text>;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }} data-testid="users-show-title">
        @{graph.profile.username}
      </Typography.Title>
      <Card title="Profile" data-testid="users-show-profile">
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <strong>{graph.profile.displayName}</strong> · id {graph.profile.id}
        </Typography.Paragraph>
        {graph.profile.bio ? (
          <Typography.Paragraph>{graph.profile.bio}</Typography.Paragraph>
        ) : null}
        <Typography.Text type="secondary">
          following {graph.profile.counts.following} · followers {graph.profile.counts.followers}
        </Typography.Text>
      </Card>
      <Card title="Followers" data-testid="users-show-followers">
        <List
          size="small"
          dataSource={graph.followers}
          locale={{ emptyText: 'No followers' }}
          renderItem={(follower) => (
            <List.Item>
              @{follower.username} ({follower.displayName})
            </List.Item>
          )}
        />
      </Card>
      <Card title="Following" data-testid="users-show-following">
        <List
          size="small"
          dataSource={graph.following}
          locale={{ emptyText: 'Follows nobody' }}
          renderItem={(followee) => (
            <List.Item>
              @{followee.username} ({followee.displayName})
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}
