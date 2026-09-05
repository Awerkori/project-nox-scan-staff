// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PanelRoutes, type PanelProps } from "./Panel";

const props: PanelProps = {
  member: {
    user_id: "admin",
    github_login: "Awerkori",
    display_name: "Awerkori",
    is_admin: true,
    roles: ["ADMIN"],
  },
  chapters: [],
  notifications: 0,
  toast: "",
  refresh: () => undefined,
  logout: () => undefined,
};
const page = (path: string) =>
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <PanelRoutes {...props} />
    </MemoryRouter>,
  );

describe("staff panel routes", () => {
  it("renders every sidebar destination as a distinct route", () => {
    expect(page("/")).toContain("Minhas tarefas");
    expect(page("/raw")).toContain("Pegar este capítulo");
    expect(page("/clean-redraw")).toContain("Capítulos disponíveis");
    expect(page("/translation")).toContain("Tradução");
    expect(page("/typeset")).toContain("Type");
    expect(page("/review")).toContain("<h2>Revisão</h2>");
    expect(page("/ready")).toContain("Pra upar");
    expect(page("/published")).toContain("Upados");
    expect(page("/works")).toContain("Nova obra");
    expect(page("/notifications")).toContain("Notificações");
    expect(page("/admin/members")).toContain("Pré-autorizar GitHub");
    expect(page("/admin/settings")).toContain("Configurações");
  });
  it("shows and authorizes production channels by role", () => {
    const rawAndType: PanelProps = {
      ...props,
      member: {
        ...props.member,
        is_admin: false,
        roles: ["RAW_PROVIDER", "TYPESETTER"],
      },
    };
    const home = renderToString(
      <MemoryRouter initialEntries={["/"]}>
        <PanelRoutes {...rawAndType} />
      </MemoryRouter>,
    );
    expect(home).toContain(">Raw<");
    expect(home).toContain(">Type<");
    expect(home).not.toContain(">Clean<");
    expect(home).not.toContain(">Tradução<");
    expect(home).not.toContain(">Revisão<");
    expect(home).not.toContain("Pra upar");
    expect(home).not.toContain("Upados");
    expect(
      renderToString(
        <MemoryRouter initialEntries={["/translation"]}>
          <PanelRoutes {...rawAndType} />
        </MemoryRouter>,
      ),
    ).toContain("Acesso restrito");
  });
});
