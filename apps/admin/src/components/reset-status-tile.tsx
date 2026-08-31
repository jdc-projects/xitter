import { Alert, Descriptions, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { ResetStatus } from '@xitter/api-contracts';
import { A11yTag } from './a11y-tag.js';
import { fetchResetStatus } from '../data/health.js';

/**
 * Data lifecycle tile for the health dashboard: the last reset/reseed run,
 * read from feed's admin-gated reset-status endpoint (T13). The record is
 * informational - null (no reset has run on this env yet, e.g. a fresh
 * local stack) and fetch failures render as distinct, honest states rather
 * than errors.
 */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1],
  ['minute', 60],
  ['hour', 3_600],
  ['day', 86_400],
  ['week', 604_800],
  ['month', 2_629_800],
  ['year', 31_557_600],
];

/** "3 hours ago"-style age for an ISO timestamp (locale-independent English). */
export function relativeTime(iso: string, nowMs = Date.now()): string {
  const deltaSeconds = Math.round((Date.parse(iso) - nowMs) / 1_000);
  let unit = UNITS[0]!;
  for (const entry of UNITS) {
    if (Math.abs(deltaSeconds) >= entry[1]) unit = entry;
  }
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
    Math.round(deltaSeconds / unit[1]),
    unit[0],
  );
}

/** "42s" / "1m 30s" / "2m 3.4s" - reset runs are seconds-to-minutes long. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** UTC wall-clock rendering ("2026-08-30 00:30 UTC") for the absolute time. */
export function utcTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

type FetchState =
  | { phase: 'loading' }
  | { phase: 'empty' }
  | { phase: 'record'; record: ResetStatus }
  | { phase: 'error'; message: string };

export function ResetStatusTile({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<FetchState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    fetchResetStatus()
      .then((record) => {
        if (!cancelled) setState(record ? { phase: 'record', record } : { phase: 'empty' });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: err instanceof Error ? err.message : 'feed unreachable',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (state.phase === 'loading') {
    return (
      <Typography.Text type="secondary" data-testid="reset-status-loading">
        Loading…
      </Typography.Text>
    );
  }

  if (state.phase === 'error') {
    return (
      <Alert
        type="warning"
        showIcon={false}
        data-testid="reset-status-error"
        message="Last reset / reseed unavailable"
        description={`feed did not answer: ${state.message}`}
      />
    );
  }

  if (state.phase === 'empty') {
    return (
      <Typography.Text type="secondary" data-testid="reset-status-empty">
        No reset recorded yet — this environment has not run a reset (fresh local stacks seed
        directly; the nightly job records every run).
      </Typography.Text>
    );
  }

  const { record } = state;
  return (
    <div data-testid="reset-status-record">
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: 'outcome',
            label: 'Outcome',
            children: (
              <Space size="small" wrap>
                {/* WCAG AA: the darker tag text colours a11y-tag applies. */}
                <span data-testid="reset-status-outcome">
                  {record.success ? (
                    <A11yTag color="green">success</A11yTag>
                  ) : (
                    <A11yTag color="red">failed</A11yTag>
                  )}
                </span>
                <Typography.Text type="secondary">{record.job}</Typography.Text>
              </Space>
            ),
          },
          {
            key: 'finished',
            label: 'Finished',
            children: (
              <span data-testid="reset-status-time">
                {relativeTime(record.finishedAt)} ({utcTimestamp(record.finishedAt)})
              </span>
            ),
          },
          {
            key: 'duration',
            label: 'Duration',
            children: (
              <span data-testid="reset-status-duration">{formatDuration(record.durationMs)}</span>
            ),
          },
          {
            key: 'reseed',
            label: 'Reseed',
            children: record.reseeded ? 'ran (deterministic corpus)' : 'not run (wipe only)',
          },
          {
            key: 'fingerprint',
            label: 'Fingerprint',
            children: record.fingerprint ? (
              <Typography.Text
                code
                copyable={{ text: record.fingerprint, tooltips: false }}
                title={record.fingerprint}
                data-testid="reset-status-fingerprint"
              >
                {record.fingerprint.slice(0, 12)}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">— (wipe only)</Typography.Text>
            ),
          },
        ]}
      />
    </div>
  );
}
