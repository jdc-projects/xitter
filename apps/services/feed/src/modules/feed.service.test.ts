import { describe, expect, it } from "vitest";
import { FeedService } from "./feed.service.js";

describe("FeedService (skeleton)", () => {
  it("returns an empty page shape", () => {
    expect(new FeedService().placeholder()).toEqual({ items: [], nextCursor: null });
  });
});
