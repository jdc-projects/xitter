import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

describe("reflector", () => {
  it("constructs", () => {
    expect(typeof new Reflector().getAllAndOverride).toBe("function");
  });
});
