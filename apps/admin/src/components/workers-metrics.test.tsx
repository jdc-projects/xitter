import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkersMetricsCard } from './workers-metrics.js';

/**
 * Environment-aware rendering (#132 follow-up): local dev names the scrape
 * ports as copy (cluster-local, only addressable on the operator's own
 * machine); deployed links the Grafana dashboards the edge host can
 * actually reach. Both branches are pinned so neither regresses into the
 * other's failure mode (dead local links / link-less deployed copy).
 */

const links = () => screen.getByTestId('health-workers').querySelectorAll('a');

describe('WorkersMetricsCard', () => {
  it('local dev: scrape ports as copy, never links', () => {
    render(<WorkersMetricsCard hostname="localhost" />);

    const card = screen.getByTestId('health-workers');
    expect(card.textContent).toContain('fanout: http://localhost:');
    expect(card.textContent).toContain('/metrics');
    // The ports are only addressable on the machine running the workers -
    // a link would 404 through the edge (#132).
    expect(links()).toHaveLength(0);
  });

  it('deployed: links the Grafana dashboards by their stable UIDs', () => {
    render(<WorkersMetricsCard hostname="xitter-dev.jd-chapman.dev" />);

    const hrefs = [...links()].map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://grafana.jd-chapman.dev/d/xitter-kafka-lag',
      'https://grafana.jd-chapman.dev/d/xitter-feed-freshness',
    ]);
    expect(screen.getByText('Kafka consumer lag')).toBeTruthy();
    expect(screen.getByText('Feed freshness / lag')).toBeTruthy();
    // Cluster-local ports must not leak into the deployed rendering.
    expect(screen.getByTestId('health-workers').textContent).not.toContain('localhost:');
  });

  it('defaults to the browser origin (localhost in the test env)', () => {
    render(<WorkersMetricsCard />);

    expect(links()).toHaveLength(0);
  });
});
