import { Alert, Badge, Button, Card, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import type { AdminHealth } from '@xitter/api-contracts';
import { fetchAllServiceHealth, WORKER_METRICS, workerMetricsPorts } from '../data/health.js';

/**
 * System health dashboard: live per-service Terminus detail (each service is
 * its own authority), worker metrics links (workers expose scrapes, not
 * APIs), and the last-reset tile - which stays "pending" until the reset
 * status feed lands with #13.
 */
export function HealthPage() {
  const [services, setServices] = useState<AdminHealth[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setServices(await fetchAllServiceHealth());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const overallOk = services?.every((service) => service.status === 'ok') ?? false;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          System health
        </Typography.Title>
        <Button icon={<ReloadOutlined aria-hidden />} onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </Space>

      <Space wrap>
        <Badge
          status={overallOk ? 'success' : services ? 'error' : 'default'}
          text={
            services ? (overallOk ? 'All services healthy' : 'Degraded - see details') : 'Loading…'
          }
        />
      </Space>

      <Table<AdminHealth>
        rowKey="service"
        dataSource={services ?? []}
        loading={!services}
        pagination={false}
        data-testid="health-table"
        columns={[
          { title: 'Service', dataIndex: 'service', key: 'service' },
          {
            title: 'Status',
            dataIndex: 'status',
            key: 'status',
            width: 110,
            render: (status: AdminHealth['status']) =>
              status === 'ok' ? <Tag color="green">ok</Tag> : <Tag color="red">error</Tag>,
          },
          {
            title: 'Checks',
            key: 'checks',
            render: (_: unknown, record) => (
              <Space direction="vertical" size={0}>
                {Object.entries(record.checks).map(([name, check]) => (
                  <Typography.Text key={name} type={check.status === 'up' ? undefined : 'danger'}>
                    {name}: {check.status}
                    {check.message ? ` (${check.message})` : ''}
                  </Typography.Text>
                ))}
              </Space>
            ),
          },
          {
            title: 'Uptime',
            dataIndex: 'uptimeSeconds',
            key: 'uptime',
            width: 110,
            render: (seconds: number) =>
              seconds ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : '—',
          },
          { title: 'API', dataIndex: 'version', key: 'version', width: 80 },
        ]}
      />

      <Card size="small" title="Workers (metrics endpoints)" data-testid="health-workers">
        <Space wrap>
          {WORKER_METRICS.map((worker) => (
            <Typography.Link
              key={worker.name}
              href={`http://localhost:${workerMetricsPorts[worker.name]}/metrics`}
              target="_blank"
              rel="noreferrer"
            >
              {worker.name} metrics
            </Typography.Link>
          ))}
        </Space>
      </Card>

      <Card size="small" title="Data lifecycle" data-testid="health-reset-status">
        {/* The reset/reseed status feed lands with #13 (data lifecycle). */}
        <Alert
          type="info"
          showIcon={false}
          message="Last reset / reseed"
          description={
            <span data-testid="reset-status-pending">
              pending — reset status reporting lands with the data-lifecycle ticket (#13)
            </span>
          }
        />
      </Card>
    </Space>
  );
}
