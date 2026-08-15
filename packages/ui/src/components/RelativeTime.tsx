"use client";

import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { Text, type TextProps } from "@mantine/core";

dayjs.extend(relativeTime);
dayjs.extend(advancedFormat);

/**
 * Feed timestamp label: relative to the most significant figure only (e.g. "1h"
 * not "1h 20m") when less than 24h old, otherwise absolute date + time.
 */
export function formatFeedTimestamp(date: string | Date, now: string | Date = new Date()): string {
  const from = dayjs(date);
  const reference = dayjs(now);
  if (reference.diff(from, "hour") >= 24) {
    return from.format("D MMM YYYY HH:mm");
  }
  const minutes = reference.diff(from, "minute");
  if (minutes < 1) return `${Math.max(reference.diff(from, "second"), 0)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${reference.diff(from, "hour")}h`;
}

export interface RelativeTimeProps extends Omit<TextProps, "children"> {
  /** ISO timestamp of the post. */
  date: string | Date;
  /** Reference point for relative rendering - defaults to now. */
  now?: string | Date;
}

export function RelativeTime({ date, now, ...textProps }: RelativeTimeProps) {
  const from = dayjs(date);
  const label = formatFeedTimestamp(date, now ?? Date.now());
  const title = from.format("dddd, D MMMM YYYY HH:mm");

  return (
    <Text component="time" dateTime={from.toISOString()} title={title} size="sm" c="dimmed" {...textProps}>
      {label}
    </Text>
  );
}
