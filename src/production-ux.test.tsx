// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PanelRoutes, type PanelProps } from "./Panel";
import type { Chapter, StageStatus } from "./types";

const translationChapter = (
  id: string,
  number: string,
  status: StageStatus,
  assignedTo: string | null = null,
  publishedAt: string | null = null,
): Chapter => ({
  id,
  number,
  title: null,
  published_at: publishedAt,
  work: { id: "work", title: "Distant Sky" },
  chapter_stages: [
    {
      id: `${id}-translation`,
      chapter_id: id,
      stage: "TRANSLATION",
      status,
      assigned_to: assignedTo,
      completed_at: status === "COMPLETED" ? new Date().toISOString() : null,
    },
    {
      id: `${id}-ready`,
      chapter_id: id,
      stage: "READY",
      status: publishedAt ? "COMPLETED" : "WAITING",
      assigned_to: null,
      completed_at: publishedAt,
    },
  ],
});

const props: PanelProps = {
  member: {
    user_id: "joao",
    github_login: "joao",
    display_name: "João",
    is_admin: false,
    roles: ["TRANSLATOR"],
  },
  chapters: [
    translationChapter("available", "81", "AVAILABLE"),
    translationChapter("mine", "82", "IN_PROGRESS", "joao"),
    translationChapter("other", "83", "IN_PROGRESS", "maria"),
    translationChapter("done", "84", "COMPLETED", "joao"),
  ],
  notifications: 0,
  toast: "",
  refresh: () => undefined,
  logout: () => undefined,
};

const page = (path: string, overrides: Partial<PanelProps> = {}) =>
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <PanelRoutes {...props} {...overrides} />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");

describe("production channel UX", () => {
  it("separates available work from the current member's chapters", () => {
    const html = page("/translation");
    expect(html).toContain("Capítulos disponíveis");
    expect(html).toContain("Meus capítulos");
    expect(html).toContain("Distant Sky #81");
    expect(html).toContain("Distant Sky #82");
    expect(html).not.toContain("Distant Sky #83");
    expect(html).not.toContain("Distant Sky #84");
  });

  it("keeps published chapters out of the active production channel", () => {
    const published = translationChapter(
      "published",
      "90",
      "AVAILABLE",
      null,
      new Date().toISOString(),
    );
    expect(
      page("/translation", { chapters: [...props.chapters, published] }),
    ).not.toContain("Distant Sky #90");
  });
});
