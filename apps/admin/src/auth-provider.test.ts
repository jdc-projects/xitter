import { describe, expect, it } from "vitest";
import { isAdminRole } from "./auth-provider.js";

describe("isAdminRole", () => {
  it("allows admin roles only", () => {
    expect(isAdminRole(["app-admin"])).toBe(true);
    expect(isAdminRole(["system-admin", "other"])).toBe(true);
    expect(isAdminRole(["demo-user"])).toBe(false);
    expect(isAdminRole([])).toBe(false);
  });
});
