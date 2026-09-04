import type { ChapterStage, Stage, StageStatus } from './types'

export const stageLabel: Record<Stage, string> = { RAW: 'Raw Provider', CLEAN_REDRAW: 'Clean / Redraw', TRANSLATION: 'Tradução', TYPESET: 'Type', REVIEW: 'Revisão / QC', READY: 'Prontos' }
export const stageRole: Record<Exclude<Stage, 'READY'>, string> = { RAW: 'RAW_PROVIDER', CLEAN_REDRAW: 'CLEAN_REDRAW', TRANSLATION: 'TRANSLATOR', TYPESET: 'TYPESETTER', REVIEW: 'REVIEWER_QC' }

export function isStageAvailable(stage: Stage, stages: Pick<ChapterStage, 'stage' | 'status'>[]): boolean {
  const done = (name: Stage) => stages.some((item) => item.stage === name && item.status === 'COMPLETED')
  if (stage === 'RAW') return true
  if (stage === 'CLEAN_REDRAW' || stage === 'TRANSLATION') return done('RAW')
  if (stage === 'TYPESET') return done('CLEAN_REDRAW') && done('TRANSLATION')
  if (stage === 'REVIEW') return done('TYPESET')
  return done('REVIEW')
}

export function nextStatuses(completed: Stage, stages: Pick<ChapterStage, 'stage' | 'status'>[]): Stage[] {
  const future = stages.map((item) => ({ ...item, status: item.stage === completed ? 'COMPLETED' as StageStatus : item.status }))
  return (['CLEAN_REDRAW', 'TRANSLATION', 'TYPESET', 'REVIEW', 'READY'] as Stage[]).filter((stage) => isStageAvailable(stage, future) && !future.some((item) => item.stage === stage && item.status === 'COMPLETED'))
}

/** Mirrors the RPC contract for unit tests; production concurrency is enforced by SELECT FOR UPDATE + a partial unique index. */
export function reserveStage<T extends Pick<ChapterStage, 'status' | 'assigned_to'>>(stage: T, userId: string): T {
  if (stage.status !== 'AVAILABLE' || stage.assigned_to) throw new Error('Esta tarefa acabou de ser assumida por outro membro.')
  return { ...stage, status: 'IN_PROGRESS', assigned_to: userId }
}
