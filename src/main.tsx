import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "./lib/supabase";
import { subscribeToProduction } from "./lib/production";
import { PanelRoutes } from "./Panel";
import type { Chapter, Role, StaffMember } from "./types";
import "./styles.css";

type AuthStatus =
  | "checking-session"
  | "unauthenticated"
  | "checking-access"
  | "authorized"
  | "unauthorized"
  | "error";

class PanelErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      "Project Nox Scan Staff dashboard render failed.",
      error,
      info,
    );
  }
  render() {
    return this.state.failed ? (
      <Gate message="Erro ao carregar o painel.">
        <p>
          Recarregue a página. Se o problema continuar, avise um administrador.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Recarregar
        </button>
      </Gate>
    ) : (
      this.props.children
    );
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [member, setMember] = useState<StaffMember | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [notifications, setNotifications] = useState(0);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking-session");
  const load = useCallback(async () => {
    if (!session || !supabase) return;
    setAuthStatus("checking-access");
    setError("");
    try {
      const { data: staff, error: staffError } = await supabase
        .from("staff_members")
        .select(
          "user_id,github_login,display_name,is_admin,user_roles(roles(code))",
        )
        .eq("user_id", session.user.id)
        .eq("is_active", true)
        .maybeSingle();
      if (staffError) {
        setMember(null);
        setAuthStatus("error");
        setError(
          `Não foi possível verificar seu acesso: ${staffError.message}`,
        );
        return;
      }
      if (!staff) {
        setMember(null);
        setAuthStatus("unauthorized");
        setError("Acesso não autorizado");
        return;
      }
      type StaffRoleRow = { roles: { code: Role } | null };
      const staffRoles =
        (staff.user_roles as unknown as StaffRoleRow[] | null) ?? [];
      const roles = staffRoles.flatMap((item) =>
        item.roles?.code ? [item.roles.code] : [],
      );
      setMember({
        user_id: staff.user_id,
        github_login: staff.github_login,
        display_name: staff.display_name,
        is_admin: staff.is_admin,
        roles,
      });
      setAuthStatus("authorized");
      const { data, error: chapterError } = await supabase
        .from("chapters")
        .select(
          "id,number,title,work:works(id,title),chapter_stages(id,chapter_id,stage,status,assigned_to,assigned_at,completed_at,assignee:profiles!chapter_stages_assigned_to_fkey(display_name,github_login,avatar_url))",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (chapterError) {
        setError(
          `Não foi possível carregar os capítulos: ${chapterError.message}`,
        );
        setChapters([]);
      } else setChapters((data ?? []) as unknown as Chapter[]);
      const { count, error: notificationError } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .is("read_at", null);
      if (notificationError)
        setError(
          `Não foi possível carregar notificações: ${notificationError.message}`,
        );
      else setNotifications(count ?? 0);
    } catch (cause) {
      setMember(null);
      setAuthStatus("error");
      setError(
        cause instanceof Error
          ? `Erro inesperado ao carregar seu acesso: ${cause.message}`
          : "Erro inesperado ao carregar seu acesso.",
      );
    }
  }, [session]);
  const claimInvite = async () => {
    if (!supabase) return;
    setError("");
    const { error } = await supabase.rpc("claim_staff_invite");
    if (error) setError(error.message);
    else await load();
  };
  useEffect(() => {
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session);
        setAuthStatus(data.session ? "checking-access" : "unauthenticated");
      })
      .catch(() => {
        setAuthStatus("error");
        setError("Não foi possível verificar a sessão.");
      });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        setSession(next);
        setMember(null);
        setAuthStatus(next ? "checking-access" : "unauthenticated");
      },
    );
    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) return;
    void load();
    const channel = subscribeToProduction(() => {
      setToast("Produção atualizada em tempo real.");
      void load();
    });
    return () => {
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [load, session]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!configured)
    return (
      <Gate message="Configuração necessária">
        <p>
          Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY. Consulte o README
          para migrations, OAuth e bootstrap seguro do administrador.
        </p>
      </Gate>
    );
  if (authStatus === "checking-session")
    return <Gate message="Verificando sessão…" />;
  if (authStatus === "unauthenticated") return <Login />;
  if (authStatus === "checking-access")
    return <Gate message="Verificando acesso…" />;
  if (authStatus === "unauthorized")
    return (
      <Gate message="Acesso não autorizado">
        <p>
          Se a staff enviou um convite depois do seu primeiro login, você pode
          vinculá-lo com segurança à conta GitHub autenticada.
        </p>
        <button className="primary" onClick={() => void claimInvite()}>
          Verificar convite
        </button>
        {error && <p className="error">{error}</p>}
      </Gate>
    );
  if (authStatus === "error")
    return (
      <Gate message="Erro ao carregar o acesso">
        <p>{error || "Tente recarregar a página."}</p>
        <button className="primary" onClick={() => window.location.reload()}>
          Recarregar
        </button>
      </Gate>
    );
  if (!member)
    return (
      <Gate message="Erro ao carregar o acesso">
        <button className="primary" onClick={() => window.location.reload()}>
          Recarregar
        </button>
      </Gate>
    );
  return (
    <HashRouter>
      <PanelRoutes
        member={member}
        chapters={chapters}
        notifications={notifications}
        toast={toast}
        refresh={() => void load()}
        logout={() => void supabase?.auth.signOut()}
      />
    </HashRouter>
  );
}

function Login() {
  const signIn = async () => {
    const { error } = await supabase!.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: window.location.href },
    });
    if (error) alert(error.message);
  };
  return (
    <Gate message="Project Nox Scan Staff">
      <button className="primary" onClick={() => void signIn()}>
        Entrar com GitHub
      </button>
      <p>
        Somente membros autorizados da staff podem acessar dados de produção.
      </p>
    </Gate>
  );
}
function Gate({
  message,
  children,
}: {
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="gate">
      <p className="eyebrow">PROJECT NOX SCAN</p>
      <h1>{message}</h1>
      {children}
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <PanelErrorBoundary>
      <App />
    </PanelErrorBoundary>,
  );
