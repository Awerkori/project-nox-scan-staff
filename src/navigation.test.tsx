// @vitest-environment jsdom
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { PanelRoutes, type PanelProps } from './Panel'

const props: PanelProps = { member: { user_id: 'admin', github_login: 'Awerkori', display_name: 'Awerkori', is_admin: true, roles: ['ADMIN'] }, chapters: [], notifications: 0, toast: '', refresh: () => undefined, logout: () => undefined }
const page = (path: string) => renderToString(<MemoryRouter initialEntries={[path]}><PanelRoutes {...props} /></MemoryRouter>)

describe('staff panel routes', () => {
  it('renders every sidebar destination as a distinct route', () => {
    expect(page('/')).toContain('Minhas tarefas')
    expect(page('/raw')).toContain('Raw Provider')
    expect(page('/clean-redraw')).toContain('Clean / Redraw')
    expect(page('/translation')).toContain('Tradução')
    expect(page('/typeset')).toContain('Type')
    expect(page('/review')).toContain('Revisão / QC')
    expect(page('/ready')).toContain('Prontos para publicação')
    expect(page('/works')).toContain('Nova obra')
    expect(page('/notifications')).toContain('Notificações')
    expect(page('/admin/members')).toContain('Pré-autorizar GitHub')
    expect(page('/admin/settings')).toContain('Configurações')
  })
})
