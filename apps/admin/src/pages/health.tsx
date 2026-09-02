import { Badge, Button, Card, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import type { AdminHealth } from '@xitter/api-contracts';
import { fetchAllServiceHealth } from '../data/health.js';
import { ResetStatusTile } from '../components/reset-status-tile.js';
import { WorkersMetricsCard } from '../components/workers-metrics.js';

/**
 * System health dashboard: live per-service Terminus detail (each service is
 * its own authority), worker metrics pointers (environment-aware - Grafana
 * links when deployed, local scrape ports in dev), and the data lifecycle
 * tile over feed's admin-gated reset-status endpoint.
 */
export function HealthPage() {
  const [services, setServices] = useState<AdminHealth[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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
        <Button
          icon={<ReloadOutlined aria-hidden />}
          onClick={() => {
            void load();
            // The reset tile rides the same refresh (same token, same
            // transport) - the key bump re-runs its fetch effect.
            setRefreshKey((key) => key + 1);
          }}
          loading={loading}
        >
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
              status === 'ok' ? (
                // antd's preset green tag (green-7 text on green-1) is 3.37:1 -
                // these darker palette endpoints clear WCAG AA.
                <Tag color="green" style={{ color: '#135200' }}>
                  ok
                </Tag>
              ) : (
                <Tag color="red" style={{ color: '#a8071a' }}>
                  error
                </Tag>
              ),
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

      <WorkersMetricsCard />

      <Card size="small" title="Data lifecycle" data-testid="health-reset-status">
        {/* The reset/reseed record as the reset job wrote it (T13): outcome,
            timing, fingerprint - or a clean empty state before the first
            reset run on the environment. */}
        <ResetStatusTile refreshKey={refreshKey} />
      </Card>
    </Space>
  );
}
