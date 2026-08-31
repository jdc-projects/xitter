import { Card, Space, Typography } from 'antd';
import {
  WORKER_DASHBOARDS,
  grafanaUrl,
  isDeployedPanel,
  workerScrapeTargets,
} from '../data/health.js';

/**
 * Worker metrics pointer card (spec 06/07, #132): workers expose scrapes,
 * not APIs, and their ports are cluster-local with no edge route - so the
 * card points operators at where the metrics actually live.
 *
 * - Deployed (panel served through the edge): links to the two Grafana
 *   dashboards that carry the workers' story. Same-origin rules don't apply
 *   - Grafana is the homelab instance both envs share.
 * - Local dev: the scrape URLs as copy, NOT links - they are only
 *   addressable on the machine running the workers, and through the edge
 *   they would be dead links.
 */
export function WorkersMetricsCard({ hostname }: { hostname?: string } = {}) {
  const deployed = isDeployedPanel(hostname);
  return (
    <Card size="small" title="Workers (metrics)" data-testid="health-workers">
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {deployed ? (
          <>
            <Typography.Text type="secondary">
              Workers expose Prometheus metrics on cluster-local scrape ports — deliberately not
              routable through the edge. Read them in Grafana:
            </Typography.Text>
            <Space wrap>
              {WORKER_DASHBOARDS.map((dashboard) => (
                <Typography.Link
                  key={dashboard.uid}
                  href={`${grafanaUrl}/d/${dashboard.uid}`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="workers-grafana-link"
                >
                  {dashboard.name}
                </Typography.Link>
              ))}
            </Space>
          </>
        ) : (
          <>
            {/* Copy, not links: the scrape ports are cluster-local (PodMonitors,
                no edge route - spec 06/07), so a link would 404 from any browser
                that is not the operator's own machine (#132). */}
            <Typography.Text type="secondary">
              Workers expose Prometheus metrics on cluster-local scrape ports — deliberately not
              routable through the edge. When deployed, read them in Grafana (Kafka consumer lag /
              Feed freshness dashboards); in local dev, scrape the ports below on the machine
              running the workers.
            </Typography.Text>
            <Space wrap>
              {workerScrapeTargets().map((worker) => (
                <Typography.Text key={worker.name} code>
                  {worker.name}: {worker.localUrl}
                </Typography.Text>
              ))}
            </Space>
          </>
        )}
      </Space>
    </Card>
  );
}
