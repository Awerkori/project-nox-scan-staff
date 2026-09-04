import { describe, expect, it } from 'vitest'
import { isStageAvailable, nextStatuses, reserveStage, stageRole } from './workflow'
import type { ChapterStage } from './types'

const stages = (done: string[] = []): Pick<ChapterStage, 'stage' | 'status'>[] => ['RAW', 'CLEAN_REDRAW', 'TRANSLATION', 'TYPESET', 'REVIEW', 'READY'].map((stage) => ({ stage: stage as ChapterStage['stage'], status: done.includes(stage) ? 'COMPLETED' : 'WAITING' }))
describe('scan workflow', () => {
  it('releases clean and translation after raw, then type only after both', () => {
    expect(isStageAvailable('CLEAN_REDRAW', stages(['RAW']))).toBe(true)
    expect(isStageAvailable('TRANSLATION', stages(['RAW']))).toBe(true)
    expect(isStageAvailable('TYPESET', stages(['RAW', 'CLEAN_REDRAW']))).toBe(false)
    expect(isStageAvailable('TYPESET', stages(['RAW', 'CLEAN_REDRAW', 'TRANSLATION']))).toBe(true)
  })
  it('releases review and ready in sequence', () => {
    expect(nextStatuses('TYPESET', stages(['RAW', 'CLEAN_REDRAW', 'TRANSLATION']))).toContain('REVIEW')
    expect(isStageAvailable('READY', stages(['RAW', 'CLEAN_REDRAW', 'TRANSLATION', 'TYPESET', 'REVIEW']))).toBe(true)
  })
  it('permits exactly one reservation for an available stage', () => {
    const available = { status: 'AVAILABLE' as const, assigned_to: null }
    const henrique = reserveStage(available, 'henrique')
    expect(henrique.assigned_to).toBe('henrique')
    expect(() => reserveStage(henrique, 'maria')).toThrow('acabou de ser assumida')
  })
  it('maps every actionable stage to its staff role', () => {
    expect(stageRole.RAW).toBe('RAW_PROVIDER')
    expect(stageRole.CLEAN_REDRAW).toBe('CLEAN_REDRAW')
    expect(stageRole.TRANSLATION).toBe('TRANSLATOR')
    expect(stageRole.TYPESET).toBe('TYPESETTER')
    expect(stageRole.REVIEW).toBe('REVIEWER_QC')
  })
})
