import { describe, expect, it } from "vitest";
import { formatFeedTimestamp } from "./RelativeTime.js";

const NOW = "2026-08-15T12:00:00Z";

describe("formatFeedTimestamp", () => {
  it("shows seconds under a minute", () => {
    expect(formatFeedTimestamp("2026-08-15T11:59:45Z", NOW)).toBe("15s");
  });

  it("shows minutes under an hour", () => {
    expect(formatFeedTimestamp("2026-08-15T11:20:00Z", NOW)).toBe("40m");
  });

  it("rounds to the most significant figure for hours", () => {
    expect(formatFeedTimestamp("2026-08-15T10:40:00Z", NOW)).toBe("1h");
  });

  it("shows absolute date and time at 24h or older", () => {
    expect(formatFeedTimestamp("2026-08-14T12:00:00Z", NOW)).toBe("14 Aug 2026 12:00");
  });

  it("never shows negative values", () => {
    expect(formatFeedTimestamp("2026-08-15T12:00:30Z", NOW)).toBe("0s");
  });
});
