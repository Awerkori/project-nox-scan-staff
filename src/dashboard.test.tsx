// @vitest-environment jsdom
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dashboard } from './main'

describe('authenticated dashboard', () => {
  it('renders an administrator with no chapters without crashing', () => {
    const html = renderToString(<Dashboard member={{ user_id: 'admin', github_login: 'Awerkori', display_name: 'Awerkori', is_admin: true, roles: ['ADMIN'] }} chapters={[]} notifications={0} toast="" onRefresh={() => undefined} onLogout={() => undefined} />)
    expect(html).toContain('Project Nox')
    expect(html).toContain('Membros')
    expect(html).toContain('Configurações')
    expect(html).toContain('Minhas tarefas')
    expect(html).toContain('Filas de produção')
  })
})
