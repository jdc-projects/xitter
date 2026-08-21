import { Button, Space, Table, Typography } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { useTable } from '@refinedev/antd';
import { useNavigate } from 'react-router';
import type { ProfileWithCounts } from '@xitter/api-contracts';
import { filterValueOf } from '../../data/data-provider.js';

/** User inspection list (read-only): profiles with graph counts. */
export function UsersListPage() {
  const navigate = useNavigate();
  const { tableProps, filters, setFilters } = useTable<ProfileWithCounts>({
    resource: 'users',
    filters: { initial: [{ field: 'username', operator: 'contains', value: '' }] },
    syncWithLocation: true,
  });

  const valueOf = () => filterValueOf(filters, 'username');

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Users
      </Typography.Title>
      <Space wrap data-testid="users-filters">
        <label htmlFor="filter-username">Username contains</label>
        <input
          id="filter-username"
          placeholder="username contains"
          value={valueOf()}
          onChange={(event) =>
            setFilters([{ field: 'username', operator: 'contains', value: event.target.value }])
          }
        />
      </Space>
      <Table<ProfileWithCounts>
        {...tableProps}
        rowKey="id"
        data-testid="users-table"
        columns={[
          {
            title: 'Username',
            dataIndex: 'username',
            key: 'username',
            render: (u: string) => `@${u}`,
          },
          { title: 'Display name', dataIndex: 'displayName', key: 'displayName' },
          {
            title: 'Following',
            key: 'following',
            width: 110,
            render: (_: unknown, record) => record.counts.following,
          },
          {
            title: 'Followers',
            key: 'followers',
            width: 110,
            render: (_: unknown, record) => record.counts.followers,
          },
          {
            title: 'Created',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 190,
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            title: 'Actions',
            key: 'actions',
            width: 90,
            render: (_: unknown, record) => (
              <Button
                size="small"
                icon={<EyeOutlined aria-hidden />}
                onClick={() => navigate(`/users/show/${record.id}`)}
                aria-label={`Show user ${record.username}`}
                data-testid={`show-user-${record.username}`}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}
