import { expect, it } from "vitest";
import { orderedStages } from "./workflow";
import type { Stage } from "./types";

it("shows the production flow in order even when database rows arrive shuffled", () => {
  const shuffled = (["CLEAN_REDRAW", "TRANSLATION", "TYPESET", "REVIEW", "READY", "RAW"] as Stage[]).map(stage => ({ stage }));
  expect(orderedStages(shuffled).map(row => row.stage)).toEqual(["RAW", "CLEAN_REDRAW", "TRANSLATION", "TYPESET", "REVIEW", "READY"]);
  expect(shuffled[0].stage).toBe("CLEAN_REDRAW");
});
