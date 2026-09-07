import type { ChapterStage } from "../types";
import { orderedStages } from "../workflow";

export function currentChapterStages(stages: ChapterStage[]): ChapterStage[] {
  const ordered = orderedStages(stages);
  const current = ordered.filter(stage => ["IN_PROGRESS", "AVAILABLE", "REJECTED"].includes(stage.status));
  if (current.length) return current;
  const waiting = ordered.find(stage => stage.status === "WAITING");
  return waiting ? [waiting] : ordered.filter(stage => stage.stage === "READY");
}
