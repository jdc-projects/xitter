import { Card, Descriptions, Space, Tag, Typography } from 'antd';
import { useOne } from '@refinedev/core';
import { useParams } from 'react-router';
import type { Post } from '@xitter/api-contracts';

/** Moderation detail: everything the posts service knows, tombstones included. */
export function PostsShowPage() {
  const { id } = useParams();
  const { query } = useOne<Post>({ resource: 'posts', id: id ?? '' });
  const post = query.data?.data;

  if (query.isLoading) return <Typography.Text>Loading…</Typography.Text>;
  if (!post) return <Typography.Text>Post not found.</Typography.Text>;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }} data-testid="posts-show-title">
        Post {post.id}
      </Typography.Title>
      <Card>
        <Descriptions column={1} bordered size="small" data-testid="posts-show-details">
          <Descriptions.Item label="State">
            {post.deletedAt ? (
              // Preset tag text fails AA - dark overrides per health.tsx.
              <Tag color="red" style={{ color: '#a8071a' }}>
                deleted {post.deletedAt}
              </Tag>
            ) : (
              <Tag color="green" style={{ color: '#135200' }}>
                live
              </Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Author">{post.authorId}</Descriptions.Item>
          <Descriptions.Item label="Text">
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
              {post.text}
            </Typography.Paragraph>
          </Descriptions.Item>
          <Descriptions.Item label="Created">{post.createdAt}</Descriptions.Item>
          <Descriptions.Item label="Counts">
            replies {post.counts.replies} · likes {post.counts.likes} · reposts{' '}
            {post.counts.reposts}
          </Descriptions.Item>
          <Descriptions.Item label="Reply to">{post.replyToId ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Repost of">{post.repostOfId ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Media">{post.media.length} attachment(s)</Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}
