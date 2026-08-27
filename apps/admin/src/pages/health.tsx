import { Alert, Badge, Button, Card, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import type { AdminHealth } from '@xitter/api-contracts';
import { fetchAllServiceHealth, workerScrapeTargets } from '../data/health.js';

/**
 * System health dashboard: live per-service Terminus detail (each service is
 * its own authority), worker metrics pointers (workers expose scrapes, not
 * APIs - and their ports are cluster-local, so they are named, not linked),
 * and the last-reset tile - which stays "pending" until the reset status
 * feed lands with #13.
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

      <Card size="small" title="Workers (metrics)" data-testid="health-workers">
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {/* Copy, not links: the scrape ports are cluster-local (PodMonitors,
              no edge route - spec 06/07), so a link would 404 from any browser
              that is not the operator's own machine (#132). */}
          <Typography.Text type="secondary">
            Workers expose Prometheus metrics on cluster-local scrape ports — deliberately not
            routable through the edge. When deployed, read them in Grafana (Kafka consumer lag /
            Feed freshness dashboards); in local dev, scrape the ports below on the machine running
            the workers.
          </Typography.Text>
          <Space wrap>
            {workerScrapeTargets().map((worker) => (
              <Typography.Text key={worker.name} code>
                {worker.name}: {worker.localUrl}
              </Typography.Text>
            ))}
          </Space>
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
