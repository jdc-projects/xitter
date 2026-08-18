'use client';

import { useEffect, useRef, useState } from 'react';

export type FeedSocketStatus = 'connecting' | 'open' | 'closed';

/** Exponential backoff (spec 03: reconnect with backoff, resubscribe). */
const backoffMs = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));

interface FeedConnection {
  destroy(): void;
}

/**
 * The ws lifecycle, kept out of the effect so the hook's effect only wires
 * creation + cleanup: fetch the session connect token, open the socket,
 * relay feed.new-items counts, reconnect with backoff. Notifications carry
 * a count hint only - no payloads (spec 03); the caller decides to refetch.
 * The token rides the query string because browsers cannot set headers on
 * ws:// upgrades.
 */
function createFeedConnection(callbacks: {
  onStatus: (status: FeedSocketStatus) => void;
  onNewItems: (count: number) => void;
}): FeedConnection {
  let socket: WebSocket | undefined;
  let attempts = 0;
  let destroyed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const scheduleRetry = () => {
    attempts += 1;
    if (!destroyed) retry = setTimeout(() => void connect(), backoffMs(attempts));
  };

  // connect never rejects: everything sits inside its try/catch.
  const connect = async () => {
    if (destroyed) return;
    try {
      const res = await fetch('/api/feed/ws-token');
      if (res.status === 401) {
        callbacks.onStatus('closed'); // signed out - no socket to make
        return;
      }
      const { token } = (await res.json()) as { token?: string };
      if (!token || destroyed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${protocol}://${window.location.host}/api/feed/v1/ws?token=${encodeURIComponent(token)}`,
      );
      socket.onopen = () => {
        attempts = 0;
        callbacks.onStatus('open');
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; count?: number };
          if (message.type === 'feed.new-items') callbacks.onNewItems(message.count ?? 1);
        } catch {
          /* not JSON - ignore, notifications are best-effort */
        }
      };
      socket.onclose = () => {
        callbacks.onStatus('closed');
        scheduleRetry();
      };
      socket.onerror = () => socket?.close();
    } catch {
      scheduleRetry();
    }
  };

  void connect();
  return {
    destroy() {
      destroyed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}

export function useFeedUpdates(onNewItems: (count: number) => void): FeedSocketStatus {
  const [status, setStatus] = useState<FeedSocketStatus>('connecting');
  // Keep the latest callback without re-subscribing on every render.
  const handler = useRef(onNewItems);
  useEffect(() => {
    handler.current = onNewItems;
  }, [onNewItems]);

  useEffect(() => {
    const connection = createFeedConnection({
      onStatus: setStatus,
      onNewItems: (count) => handler.current(count),
    });
    return () => connection.destroy();
  }, []);

  return status;
}
