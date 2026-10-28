// ?tab=upload deep-link: ad and break-out traffic must land on the
// Upload ZIP Codebase tab, while every other landing keeps the default
// tab — including when Facebook appends its fbclid param alongside.
import { describe, it, expect } from "vitest";
import { initialTabFromSearch } from "../src/utils/tabDeepLink";

describe("initialTabFromSearch", () => {
  it("opens the upload tab for ?tab=upload", () => {
    expect(initialTabFromSearch("?tab=upload")).toBe("zip");
  });

  it("keeps the upload tab when Facebook appends fbclid, either order", () => {
    expect(initialTabFromSearch("?tab=upload&fbclid=abc123")).toBe("zip");
    expect(initialTabFromSearch("?fbclid=abc123&tab=upload")).toBe("zip");
  });

  it("keeps the default tab for anything else", () => {
    expect(initialTabFromSearch("")).toBe("generate");
    expect(initialTabFromSearch("?tab=bogus")).toBe("generate");
    expect(initialTabFromSearch("?tab=")).toBe("generate");
    expect(initialTabFromSearch("?fbclid=abc123")).toBe("generate");
  });
});
