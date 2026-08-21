import { Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { adminAuditPageSchema, type AdminAuditEntry } from '@xitter/api-contracts';
import { adminFetch } from '../data/admin-fetch.js';

/**
 * Moderation audit trail, merged from the two stores that write entries
 * (posts + media own their logs; the panel is the aggregation point). Who
 * deleted what, when - demo accountability, newest first.
 */
export function AuditPage() {
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pages = await Promise.allSettled([
        adminFetch('/api/posts/internal/admin/audit', { query: { limit: '100' } }, (value) =>
          adminAuditPageSchema.parse(value),
        ),
        adminFetch('/api/media/internal/admin/audit', { query: { limit: '100' } }, (value) =>
          adminAuditPageSchema.parse(value),
        ),
      ]);
      if (cancelled) return;
      const merged = pages
        .flatMap((page) => (page.status === 'fulfilled' ? page.value.items : []))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setEntries(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const colorFor = (action: AdminAuditEntry['action']) =>
    action.endsWith('hard-delete') ? 'red' : action === 'post.restore' ? 'green' : 'orange';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Moderation audit log
      </Typography.Title>
      <Table<AdminAuditEntry>
        rowKey={(entry) => `${entry.id}`}
        dataSource={entries ?? []}
        loading={!entries}
        pagination={{ pageSize: 20 }}
        data-testid="audit-table"
        columns={[
          {
            title: 'When',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 210,
            render: (value: string) => new Date(value).toLocaleString(),
          },
          { title: 'Who', dataIndex: 'actorName', key: 'actorName', width: 160 },
          {
            title: 'Action',
            dataIndex: 'action',
            key: 'action',
            width: 170,
            render: (action: AdminAuditEntry['action']) => (
              <Tag color={colorFor(action)}>{action}</Tag>
            ),
          },
          { title: 'Target', dataIndex: 'targetId', key: 'targetId', ellipsis: true },
        ]}
      />
    </Space>
  );
}
