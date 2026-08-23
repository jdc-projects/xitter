import { Button, Space, Table, Tag, Typography, App as AntApp } from 'antd';
import { DeleteOutlined, EyeOutlined, RedoOutlined } from '@ant-design/icons';
import { useCustomMutation } from '@refinedev/core';
import { useTable } from '@refinedev/antd';
import { useNavigate } from 'react-router';
import type { Post } from '@xitter/api-contracts';
import { filterValueOf } from '../../data/data-provider.js';

/**
 * Posts moderation list: filter by author, text, or deleted state; soft
 * delete (default, restorable), hard delete, and restore act through the
 * posts service's internal admin endpoints and are audit-logged there.
 * All mutations go through the data provider's custom() so they carry the
 * session token uniformly.
 */
export function PostsListPage() {
  const navigate = useNavigate();
  const { mutate: custom } = useCustomMutation();
  // Hook-based modal: antd v5's static Modal.confirm needs the <App>
  // wrapper context, and the hook form renders reliably either way.
  const { modal } = AntApp.useApp();

  const { tableProps, tableQuery, filters, setFilters } = useTable<Post>({
    resource: 'posts',
    filters: {
      initial: [
        { field: 'text', operator: 'contains', value: '' },
        { field: 'authorId', operator: 'eq', value: '' },
        { field: 'deleted', operator: 'eq', value: '' },
      ],
    },
    syncWithLocation: true,
  });

  const valueOf = (field: 'text' | 'authorId' | 'deleted') => filterValueOf(filters, field);

  const applyFilters = (patch: Record<string, string>) => {
    const base = {
      text: valueOf('text'),
      authorId: valueOf('authorId'),
      deleted: valueOf('deleted'),
      ...patch,
    };
    setFilters([
      { field: 'text', operator: 'contains', value: base.text },
      { field: 'authorId', operator: 'eq', value: base.authorId },
      { field: 'deleted', operator: 'eq', value: base.deleted },
    ]);
  };

  const remove = (post: Post, hard: boolean) => {
    custom(
      {
        url: `/api/posts/internal/admin/posts/${post.id}${hard ? '?hard=true' : ''}`,
        method: 'delete',
        values: {},
      },
      { onSuccess: () => void tableQuery.refetch() },
    );
  };

  const confirmDelete = (post: Post, hard: boolean) => {
    modal.confirm({
      title: hard ? 'Hard-delete this post?' : 'Soft-delete this post?',
      content: hard
        ? 'The row and its interactions are removed permanently. This cannot be undone.'
        : 'The post disappears for users everywhere and can be restored later.',
      okButtonProps: { danger: true },
      okText: hard ? 'Hard delete' : 'Delete',
      onOk: () => remove(post, hard),
    });
  };

  const restore = (post: Post) => {
    custom(
      { url: `/api/posts/internal/admin/posts/${post.id}/restore`, method: 'post', values: {} },
      { onSuccess: () => void tableQuery.refetch() },
    );
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Posts moderation
      </Typography.Title>
      <Space wrap data-testid="posts-filters">
        <label htmlFor="filter-text">Text contains</label>
        <input
          id="filter-text"
          placeholder="text contains"
          value={valueOf('text')}
          onChange={(event) => applyFilters({ text: event.target.value })}
        />
        <label htmlFor="filter-author">Author id</label>
        <input
          id="filter-author"
          placeholder="author id"
          value={valueOf('authorId')}
          onChange={(event) => applyFilters({ authorId: event.target.value })}
        />
        <label htmlFor="filter-deleted">Deleted</label>
        <select
          id="filter-deleted"
          value={valueOf('deleted')}
          onChange={(event) => applyFilters({ deleted: event.target.value })}
        >
          <option value="">any</option>
          <option value="false">live only</option>
          <option value="true">deleted only</option>
        </select>
      </Space>
      <Table<Post>
        {...tableProps}
        rowKey="id"
        data-testid="posts-table"
        columns={[
          {
            title: 'Post',
            dataIndex: 'text',
            key: 'text',
            ellipsis: true,
            render: (text: string, record) => (
              <Space direction="vertical" size={0}>
                <span>{text}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {record.authorId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: 'Created',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 190,
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            title: 'Counts',
            key: 'counts',
            width: 150,
            render: (_: unknown, record) =>
              `replies ${record.counts.replies} likes ${record.counts.likes} reposts ${record.counts.reposts}`,
          },
          {
            title: 'State',
            dataIndex: 'deletedAt',
            key: 'deletedAt',
            width: 110,
            render: (deletedAt: string | null) =>
              // Preset tag text fails AA (green #389e0d on #f6ffed = 3.37:1);
              // the inline dark overrides match health.tsx's pattern.
              deletedAt ? (
                <Tag color="red" style={{ color: '#a8071a' }}>
                  deleted
                </Tag>
              ) : (
                <Tag color="green" style={{ color: '#135200' }}>
                  live
                </Tag>
              ),
          },
          {
            title: 'Actions',
            key: 'actions',
            width: 210,
            render: (_: unknown, record) => (
              <Space aria-label={`Actions for post ${record.id}`}>
                <Button
                  size="small"
                  icon={<EyeOutlined aria-hidden />}
                  onClick={() => navigate(`/posts/show/${record.id}`)}
                  aria-label={`Show post ${record.id}`}
                />
                {record.deletedAt ? (
                  <Button
                    size="small"
                    icon={<RedoOutlined aria-hidden />}
                    onClick={() => restore(record)}
                    aria-label={`Restore post ${record.id}`}
                    data-testid={`restore-post-${record.id}`}
                  >
                    Restore
                  </Button>
                ) : (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined aria-hidden />}
                    onClick={() => confirmDelete(record, false)}
                    aria-label={`Delete post ${record.id}`}
                    data-testid={`delete-post-${record.id}`}
                  >
                    Delete
                  </Button>
                )}
                <Button
                  size="small"
                  danger
                  type="text"
                  icon={<DeleteOutlined aria-hidden />}
                  onClick={() => confirmDelete(record, true)}
                  aria-label={`Hard delete post ${record.id}`}
                />
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
