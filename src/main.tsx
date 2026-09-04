import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, NavLink } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './lib/supabase'
import { claimStage, releaseStage, subscribeToProduction } from './lib/production'
import { stageLabel, stageRole } from './workflow'
import type { Chapter, ChapterStage, Role, StaffMember } from './types'
import './styles.css'

const nav = [['🏠', 'Início'], ['📥', 'Raw Provider'], ['🎨', 'Clean / Redraw'], ['🌐', 'Tradução'], ['✒️', 'Type'], ['🔎', 'Revisão / QC'], ['✅', 'Prontos'], ['📚', 'Obras'], ['🔔', 'Notificações']]
type AuthStatus = 'checking-session' | 'unauthenticated' | 'checking-access' | 'authorized' | 'unauthorized' | 'error'

class PanelErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* The visible fallback intentionally does not expose internal details. */ }
  render() { return this.state.failed ? <Gate message="Erro ao carregar o painel."><p>Recarregue a página. Se o problema continuar, avise um administrador.</p><button className="primary" onClick={() => window.location.reload()}>Recarregar</button></Gate> : this.props.children }
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [member, setMember] = useState<StaffMember | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [notifications, setNotifications] = useState(0)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking-session')
  const load = useCallback(async () => {
    if (!session || !supabase) return
    setAuthStatus('checking-access')
    setError('')
    try {
      const { data: staff, error: staffError } = await supabase.from('staff_members').select('user_id,github_login,display_name,is_admin,user_roles(roles(code))').eq('user_id', session.user.id).eq('is_active', true).maybeSingle()
      if (staffError) { setMember(null); setAuthStatus('error'); setError(`Não foi possível verificar seu acesso: ${staffError.message}`); return }
      if (!staff) { setMember(null); setAuthStatus('unauthorized'); setError('Acesso não autorizado'); return }
      type StaffRoleRow = { roles: { code: Role } | null }
      const staffRoles = (staff.user_roles as unknown as StaffRoleRow[] | null) ?? []
      const roles = staffRoles.flatMap((item) => item.roles?.code ? [item.roles.code] : [])
      setMember({ user_id: staff.user_id, github_login: staff.github_login, display_name: staff.display_name, is_admin: staff.is_admin, roles })
      setAuthStatus('authorized')
      const { data, error: chapterError } = await supabase.from('chapters').select('id,number,title,work:works(title),chapter_stages(id,chapter_id,stage,status,assigned_to,assigned_at,completed_at,assignee:profiles!chapter_stages_assigned_to_fkey(display_name,github_login,avatar_url))').order('created_at', { ascending: false }).limit(100)
      if (chapterError) { setError(`Não foi possível carregar os capítulos: ${chapterError.message}`); setChapters([]) } else setChapters((data ?? []) as unknown as Chapter[])
      const { count, error: notificationError } = await supabase.from('notifications').select('*', { count: 'exact', head: true }).is('read_at', null)
      if (notificationError) setError(`Não foi possível carregar notificações: ${notificationError.message}`)
      else setNotifications(count ?? 0)
    } catch (cause) {
      setMember(null)
      setAuthStatus('error')
      setError(cause instanceof Error ? `Erro inesperado ao carregar seu acesso: ${cause.message}` : 'Erro inesperado ao carregar seu acesso.')
    }
  }, [session])
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthStatus(data.session ? 'checking-access' : 'unauthenticated') }).catch(() => { setAuthStatus('error'); setError('Não foi possível verificar a sessão.') })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setMember(null); setAuthStatus(next ? 'checking-access' : 'unauthenticated') })
    return () => listener.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (!session) return
    void load()
    const channel = subscribeToProduction(() => { setToast('Produção atualizada em tempo real.'); void load() })
    return () => { if (channel && supabase) void supabase.removeChannel(channel) }
  }, [load, session])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer) }, [toast])
  if (!configured) return <Gate message="Configuração necessária"><p>Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY. Consulte o README para migrations, OAuth e bootstrap seguro do administrador.</p></Gate>
  if (authStatus === 'checking-session') return <Gate message="Verificando sessão…" />
  if (authStatus === 'unauthenticated') return <Login />
  if (authStatus === 'checking-access') return <Gate message="Verificando acesso…" />
  if (authStatus === 'unauthorized') return <Gate message="Acesso não autorizado" />
  if (authStatus === 'error') return <Gate message="Erro ao carregar o acesso"><p>{error || 'Tente recarregar a página.'}</p><button className="primary" onClick={() => window.location.reload()}>Recarregar</button></Gate>
  if (!member) return <Gate message="Erro ao carregar o acesso"><button className="primary" onClick={() => window.location.reload()}>Recarregar</button></Gate>
  return <Dashboard member={member} chapters={chapters} notifications={notifications} toast={toast} onRefresh={() => void load()} onLogout={() => void supabase?.auth.signOut()} />
}

function Login() {
  const signIn = async () => { const { error } = await supabase!.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.href } }); if (error) alert(error.message) }
  return <Gate message="Project Nox Scan Staff"><button className="primary" onClick={() => void signIn()}>Entrar com GitHub</button><p>Somente membros autorizados da staff podem acessar dados de produção.</p></Gate>
}
function Gate({ message, children }: { message: string; children?: React.ReactNode }) { return <main className="gate"><p className="eyebrow">PROJECT NOX SCAN</p><h1>{message}</h1>{children}</main> }

export function Dashboard({ member, chapters, notifications, toast, onRefresh, onLogout }: { member: StaffMember; chapters: Chapter[]; notifications: number; toast: string; onRefresh: () => void; onLogout: () => void }) {
  const mine = useMemo(() => chapters.flatMap((chapter) => (chapter.chapter_stages ?? []).filter((stage) => stage.assigned_to === member.user_id && stage.status === 'IN_PROGRESS').map((stage) => ({ chapter, stage }))), [chapters, member.user_id])
  const queue = useMemo(() => chapters.flatMap((chapter) => (chapter.chapter_stages ?? []).filter((stage) => stage.status === 'AVAILABLE' || stage.status === 'IN_PROGRESS').map((stage) => ({ chapter, stage }))), [chapters])
  return <HashRouter><div className="app"><aside><h1>Project Nox <small>Scan Staff</small></h1><nav>{nav.map(([icon, label]) => <NavLink key={label} to="/"><span>{icon}</span>{label}</NavLink>)}{member.is_admin && <><p>ADMIN</p><NavLink to="/"><span>👥</span>Membros</NavLink><NavLink to="/"><span>⚙️</span>Configurações</NavLink></>}</nav><div className="profile"><strong>{member.display_name || member.github_login}</strong><span>@{member.github_login} · {(member.roles ?? []).join(', ') || 'Staff'}</span><button onClick={onLogout}>Sair</button></div></aside><main><header><div><p className="eyebrow">PAINEL DE PRODUÇÃO</p><h2>Início</h2></div><button className="bell" aria-label={`${notifications} notificações não lidas`}>🔔{notifications ? <b>{notifications}</b> : null}</button></header>{toast ? <div className="toast" role="status">{toast}</div> : null}<section className="dashboard-grid"><Panel title="Minhas tarefas">{mine.length ? mine.map(({ chapter, stage }) => <Task key={stage.id} chapter={chapter} stage={stage} member={member} onChanged={onRefresh} />) : <Empty text="Nenhuma tarefa atribuída a você." />}</Panel><Panel title="Filas de produção">{queue.length ? queue.map(({ chapter, stage }) => <Task key={stage.id} chapter={chapter} stage={stage} member={member} onChanged={onRefresh} />) : <Empty text="Nenhum capítulo aguardando uma etapa." />}</Panel><Panel title="Capítulos em andamento">{chapters.length ? chapters.map((chapter) => <article className="chapter" key={chapter.id}><strong>{chapter.work?.title} #{chapter.number}</strong><span>{(chapter.chapter_stages ?? []).map((stage) => `${stageLabel[stage.stage]}: ${stage.status}`).join(' · ')}</span></article>) : <Empty text="Nenhum capítulo em andamento." />}</Panel></section></main></div></HashRouter>
}

function Task({ chapter, stage, member, onChanged }: { chapter: Chapter; stage: ChapterStage; member: StaffMember; onChanged: () => void }) {
  const [message, setMessage] = useState('')
  const required = stage.stage === 'READY' ? 'ADMIN' : stageRole[stage.stage as keyof typeof stageRole]
  const canClaim = stage.status === 'AVAILABLE' && (member.is_admin || member.roles.includes(required as Role))
  const canRelease = stage.status === 'IN_PROGRESS' && (member.is_admin || stage.assigned_to === member.user_id)
  const perform = async (action: 'claim' | 'release') => { try { if (action === 'claim') await claimStage(stage.id); else await releaseStage(stage.id); onChanged() } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Não foi possível atualizar a tarefa.') } }
  return <article className="task"><strong>{chapter.work?.title} #{chapter.number}</strong><span>{stageLabel[stage.stage]} · {stage.status === 'AVAILABLE' ? 'Disponível' : 'Em andamento'}</span>{stage.assignee ? <span className="assignee">{stage.assignee.avatar_url ? <img src={stage.assignee.avatar_url} alt="" /> : '👤'} {stage.assignee.display_name || stage.assignee.github_login}{stage.assigned_at ? ` · ${new Date(stage.assigned_at).toLocaleString('pt-BR')}` : ''}</span> : null}{canClaim ? <button className="primary" onClick={() => void perform('claim')}>Assumir tarefa</button> : null}{canRelease ? <button className="secondary" onClick={() => void perform('release')}>Liberar tarefa</button> : null}{message ? <small className="error">{message}</small> : null}</article>
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <section className="panel"><h3>{title}</h3>{children}</section> }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p> }
const root = document.getElementById('root')
if (root) createRoot(root).render(<PanelErrorBoundary><App /></PanelErrorBoundary>)
