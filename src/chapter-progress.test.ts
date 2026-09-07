import { describe, expect, it } from "vitest";
import { currentChapterStages } from "./lib/chapterProgress";
import type { ChapterStage, Stage, StageStatus } from "./types";
const s = (stage: Stage, status: StageStatus): ChapterStage => ({ id: stage, stage, status, chapter_id: "chapter", assigned_to: null, completed_at: null });
describe("Home current stages", () => {
  it("shows parallel Clean and Translation, never completed RAW", () => {
    expect(currentChapterStages([s("TYPESET", "WAITING"),s("TRANSLATION","IN_PROGRESS"),s("RAW","COMPLETED"),s("CLEAN_REDRAW","AVAILABLE")]).map(s => s.stage)).toEqual(["CLEAN_REDRAW","TRANSLATION"]);
  });
  it("shows the next waiting stage if nothing is active", () => {
    expect(currentChapterStages([s("RAW","COMPLETED"),s("TYPESET","WAITING"),s("REVIEW","WAITING")])[0].stage).toBe("TYPESET");
  });
});
