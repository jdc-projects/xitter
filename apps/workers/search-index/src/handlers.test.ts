import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@xitter/events";
import { handleEvent } from "./handlers.js";

describe("search-index handleEvent (skeleton)", () => {
  it("accepts post events without throwing", async () => {
    await expect(
      handleEvent({ eventType: EVENT_TYPES.postCreated }, { searchInternalUrl: "http://localhost:8105" }),
    ).resolves.toBeUndefined();
  });
});
