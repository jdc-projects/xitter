import { Button, Image, Modal, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useCustomMutation } from '@refinedev/core';
import { useTable } from '@refinedev/antd';
import type { InternalMediaAsset } from '@xitter/api-contracts';
import { filterValueOf } from '../../data/data-provider.js';

/**
 * Media moderation list: owner/status filters, variant preview (served from
 * /media by the edge), and delete - the media service cascades RustFS object
 * deletion (original + variants), so removal here is complete.
 */
export function MediaListPage() {
  const { mutate: custom } = useCustomMutation();
  const { tableProps, tableQuery, filters, setFilters } = useTable<InternalMediaAsset>({
    resource: 'media',
    filters: {
      initial: [
        { field: 'ownerId', operator: 'eq', value: '' },
        { field: 'status', operator: 'eq', value: '' },
      ],
    },
    syncWithLocation: true,
  });

  const valueOf = (field: 'ownerId' | 'status') => filterValueOf(filters, field);

  const applyFilters = (patch: Record<string, string>) => {
    const base = { ownerId: valueOf('ownerId'), status: valueOf('status'), ...patch };
    setFilters([
      { field: 'ownerId', operator: 'eq', value: base.ownerId },
      { field: 'status', operator: 'eq', value: base.status },
    ]);
  };

  const remove = (asset: InternalMediaAsset) => {
    Modal.confirm({
      title: 'Delete this image?',
      content: 'The metadata row and every stored object (original + variants) are removed.',
      okButtonProps: { danger: true },
      okText: 'Delete',
      onOk: () =>
        new Promise<void>((resolve, reject) => {
          custom(
            { url: `/api/media/internal/admin/media/${asset.id}`, method: 'delete', values: {} },
            {
              onSuccess: () => {
                void tableQuery.refetch();
                resolve();
              },
              onError: reject,
            },
          );
        }),
    });
  };

  const thumb = (asset: InternalMediaAsset) =>
    asset.variants.find((variant) => variant.kind === 'thumb')?.url;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Media moderation
      </Typography.Title>
      <Space wrap data-testid="media-filters">
        <label htmlFor="filter-owner">Owner id</label>
        <input
          id="filter-owner"
          placeholder="owner id"
          value={valueOf('ownerId')}
          onChange={(event) => applyFilters({ ownerId: event.target.value })}
        />
        <label htmlFor="filter-status">Status</label>
        <select
          id="filter-status"
          value={valueOf('status')}
          onChange={(event) => applyFilters({ status: event.target.value })}
        >
          <option value="">any</option>
          <option value="pending">pending</option>
          <option value="ready">ready</option>
          <option value="failed">failed</option>
        </select>
      </Space>
      <Table<InternalMediaAsset>
        {...tableProps}
        rowKey="id"
        data-testid="media-table"
        columns={[
          {
            title: 'Preview',
            key: 'preview',
            width: 90,
            render: (_: unknown, record) =>
              thumb(record) ? (
                <Image
                  src={thumb(record)}
                  width={64}
                  height={64}
                  style={{ objectFit: 'cover' }}
                  alt={`Media ${record.id}`}
                />
              ) : (
                <Tag>none</Tag>
              ),
          },
          { title: 'Id', dataIndex: 'id', key: 'id', ellipsis: true },
          { title: 'Owner', dataIndex: 'ownerId', key: 'ownerId', ellipsis: true },
          {
            title: 'Status',
            dataIndex: 'status',
            key: 'status',
            width: 110,
            render: (status: string) => (
              <Tag color={status === 'ready' ? 'green' : status === 'failed' ? 'red' : 'orange'}>
                {status}
              </Tag>
            ),
          },
          {
            title: 'Bytes',
            dataIndex: 'bytes',
            key: 'bytes',
            width: 100,
            render: (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`,
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
            width: 120,
            render: (_: unknown, record) => (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined aria-hidden />}
                onClick={() => remove(record)}
                aria-label={`Delete media ${record.id}`}
                data-testid={`delete-media-${record.id}`}
              >
                Delete
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );
}
