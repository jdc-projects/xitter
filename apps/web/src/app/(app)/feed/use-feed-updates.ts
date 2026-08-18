'use client';

import { useEffect, useRef, useState } from 'react';

export type FeedSocketStatus = 'connecting' | 'open' | 'closed';

/** Exponential backoff (spec 03: reconnect with backoff, resubscribe). */
const backoffMs = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));

/**
 * Subscribe to feed.new-items notifications (spec 03): the server pushes a
 * count hint only - no payloads - and the caller decides to refetch. The
 * connect token comes from the web's session route (browsers cannot set
 * headers on ws://, so the contract puts it in the query string).
 */
export function useFeedUpdates(onNewItems: (count: number) => void): FeedSocketStatus {
  const [status, setStatus] = useState<FeedSocketStatus>('connecting');
  // Keep the latest callback without re-subscribing on every render.
  const handler = useRef(onNewItems);
  handler.current = onNewItems;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let cancelled = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/feed/ws-token');
        if (res.status === 401) {
          setStatus('closed'); // signed out - no socket to make
          return;
        }
        const { token } = (await res.json()) as { token?: string };
        if (!token || cancelled) return;

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(
          `${protocol}://${window.location.host}/api/feed/v1/ws?token=${encodeURIComponent(token)}`,
        );
        socket.onopen = () => {
          attempts = 0;
          setStatus('open');
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string; count?: number };
            if (message.type === 'feed.new-items') handler.current(message.count ?? 1);
          } catch {
            /* not JSON - ignore, notifications are best-effort */
          }
        };
        socket.onclose = () => {
          setStatus('closed');
          if (!cancelled) retry = setTimeout(() => void connect(), backoffMs(++attempts));
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!cancelled) retry = setTimeout(() => void connect(), backoffMs(++attempts));
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return status;
}
