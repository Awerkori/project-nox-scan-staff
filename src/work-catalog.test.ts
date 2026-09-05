import { describe, expect, it } from "vitest";
import { canRemoveCatalogChapter, parseChapterRange } from "./WorkCatalog";

describe("simple work catalog", () => {
  it("parses one chapter and a chapter range", () => {
    expect(parseChapterRange("single", "81", "", "")).toEqual({
      from: 81,
      to: 81,
    });
    expect(parseChapterRange("range", "", "1", "80")).toEqual({
      from: 1,
      to: 80,
    });
    expect(parseChapterRange("range", "", "80", "1")).toBeNull();
  });

  it("prevents production chapters from being removed", () => {
    expect(canRemoveCatalogChapter("TODO")).toBe(true);
    expect(canRemoveCatalogChapter("COMPLETED")).toBe(true);
    expect(canRemoveCatalogChapter("IN_PRODUCTION")).toBe(false);
    expect(canRemoveCatalogChapter("COMPLETED", true)).toBe(false);
  });
});
