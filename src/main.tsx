import {
  Component,
  useCallback,
  useEffect,
  useRef,
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
import { fetchChapters } from "./lib/chapters";
import type { Chapter, Role, StaffMember } from "./types";
import "@fontsource-variable/dm-sans";
import "@fontsource/marcellus/400.css";
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
  const [publicationAvailable, setPublicationAvailable] = useState(true);
  const [notifications, setNotifications] = useState(0);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking-session");
  const loading = useRef<Promise<void> | null>(null);
  const currentUser = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!session || !supabase) return;
    const client = supabase;
    if (loading.current) return loading.current;
    const work = async () => {
      setError("");
      try {
        const { error: accessError } = await client.rpc("claim_staff_invite");
        if (currentUser.current !== session.user.id) return;
        if (accessError) {
          setMember(null);
          setAuthStatus("unauthorized");
          setError(accessError.message);
          return;
        }
        const { data: staff, error: staffError } = await client
          .from("staff_members")
          .select(
            "user_id,github_login,display_name,is_admin,user_roles(roles(code))",
          )
          .eq("user_id", session.user.id)
          .eq("is_active", true)
          .maybeSingle();
        if (currentUser.current !== session.user.id) return;
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
        const returnPath = sessionStorage.getItem("nox-return-path");
        if (returnPath?.startsWith("/") && !returnPath.startsWith("//")) {
          sessionStorage.removeItem("nox-return-path");
          window.location.hash = returnPath;
        }
        const {
          data,
          error: chapterError,
          publicationAvailable: available,
        } = await fetchChapters();
        if (currentUser.current !== session.user.id) return;
        setPublicationAvailable(available);
        if (chapterError) {
          setError(
            `Não foi possível carregar os capítulos: ${chapterError.message}`,
          );
          setChapters([]);
        } else setChapters((data ?? []) as unknown as Chapter[]);
        const { count, error: notificationError } = await client
          .from("notifications")
          .select("*", { count: "exact", head: true })
          .eq("recipient_id", session.user.id)
          .is("read_at", null);
        if (notificationError)
          setError(
            `Não foi possível carregar notificações: ${notificationError.message}`,
          );
        else setNotifications(count ?? 0);
      } catch (cause) {
        if (currentUser.current !== session.user.id) return;
        setMember(null);
        setAuthStatus("error");
        setError(
          cause instanceof Error
            ? `Erro inesperado ao carregar seu acesso: ${cause.message}`
            : "Erro inesperado ao carregar seu acesso.",
        );
      }
    };
    const promise = work();
    loading.current = promise;
    void promise.finally(() => {
      if (loading.current === promise) loading.current = null;
    });
    return promise;
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
    const acceptSession = (next: Session | null) => {
      const id = next?.user.id ?? null;
      if (currentUser.current === id && next) return;
      currentUser.current = id;
      loading.current = null;
      setSession(next);
      setMember(null);
      setChapters([]);
      setAuthStatus(next ? "checking-access" : "unauthenticated");
    };
    supabase.auth
      .getSession()
      .then(({ data }) => {
        acceptSession(data.session);
      })
      .catch(() => {
        setAuthStatus("error");
        setError("Não foi possível verificar a sessão.");
      });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, next) => {
        if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
        acceptSession(next);
      },
    );
    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) return;
    void load();
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 350);
    };
    const channel = subscribeToProduction(sync);
    const fallback = window.setInterval(sync, 30000);
    window.addEventListener("focus", sync);
    return () => {
      clearTimeout(timer);
      clearInterval(fallback);
      window.removeEventListener("focus", sync);
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
          Seu acesso precisa ser liberado pela administração. Confira se entrou
          com a mesma conta GitHub informada no convite.
        </p>
        <button className="primary" onClick={() => void claimInvite()}>
          Verificar convite
        </button>
        <button
          className="secondary"
          onClick={() => void supabase?.auth.signOut()}
        >
          Usar outra conta
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
        error={error}
        publicationAvailable={publicationAvailable}
        refresh={load}
        logout={() => void supabase?.auth.signOut()}
      />
    </HashRouter>
  );
}

function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signIn = async () => {
    if (busy) return;
    setBusy(true);
    const path = window.location.hash.slice(1);
    if (path.startsWith("/") && !path.startsWith("//"))
      sessionStorage.setItem("nox-return-path", path);
    const { error } = await supabase!.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  };
  return (
    <Gate message="Project Nox Scan Staff">
      <button className="primary" disabled={busy} onClick={() => void signIn()}>
        {busy ? "Abrindo GitHub…" : "Entrar com GitHub"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
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
