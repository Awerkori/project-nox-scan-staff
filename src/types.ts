export const STAGES = ['RAW', 'CLEAN_REDRAW', 'TRANSLATION', 'TYPESET', 'REVIEW', 'READY'] as const
export type Stage = typeof STAGES[number]
export type StageStatus = 'WAITING' | 'AVAILABLE' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED'
export type Role = 'ADMIN' | 'RAW_PROVIDER' | 'TRANSLATOR' | 'CLEAN_REDRAW' | 'TYPESETTER' | 'REVIEWER_QC'
export type Assignee = { display_name: string | null; github_login: string; avatar_url: string | null }
export type ChapterStage = { id: string; chapter_id: string; stage: Stage; status: StageStatus; assigned_to: string | null; assigned_at?: string | null; completed_at: string | null; assignee?: Assignee | null }
export type Chapter = { id: string; number: string; title: string | null; work: { id: string; title: string } | null; chapter_stages: ChapterStage[] }
export type StaffMember = { user_id: string; github_login: string; display_name: string | null; is_admin: boolean; roles: Role[] }
