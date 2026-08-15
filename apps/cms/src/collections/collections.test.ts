import { describe, expect, it } from "vitest";
import { LandingContent } from "./landing-content.js";
import { Faq } from "./faq.js";

describe("CMS collections", () => {
  it("exposes the expected content collections", () => {
    expect(LandingContent.slug).toBe("landing-content");
    expect(Faq.slug).toBe("faq");
  });

  it("site content is publicly readable (served through the web app)", () => {
    expect(LandingContent.access?.read?.({ req: {} as never })).toBe(true);
    expect(Faq.access?.read?.({ req: {} as never })).toBe(true);
  });
});
