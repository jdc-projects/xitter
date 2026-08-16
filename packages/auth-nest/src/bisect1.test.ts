import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

describe("nest", () => {
  it("builds an exception", () => {
    expect(new HttpException("x", 400).getStatus()).toBe(400);
  });
});
