import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Stage } from '../types'

export type ArtifactInput = {
  chapterId: string
  stage: Stage
  file: File
  note?: string
}

function client() {
  if (!supabase) throw new Error('Supabase não foi configurado.')
  return supabase
}

export async function claimStage(stageId: string) {
  const { data, error } = await client().rpc('claim_stage', { p_stage_id: stageId })
  if (error) throw error
  return data
}

export async function releaseStage(stageId: string) {
  const { data, error } = await client().rpc('release_stage', { p_stage_id: stageId })
  if (error) throw error
  return data
}

export async function markNotificationRead(notificationId: string) {
  const { error } = await client().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', notificationId)
  if (error) throw error
}

export async function markAllNotificationsRead() {
  const { error } = await client().from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)
  if (error) throw error
}

export async function completeStage(stageId: string, note?: string) {
  const { data, error } = await client().rpc('complete_stage', { p_stage_id: stageId, p_note: note ?? null })
  if (error) throw error
  return data
}

export async function reviewChapter(stageId: string, approved: boolean, reason?: string, returnStage?: Stage) {
  const { error } = await client().rpc('review_chapter', {
    p_stage_id: stageId,
    p_approved: approved,
    p_reason: reason ?? null,
    p_return_stage: returnStage ?? null,
  })
  if (error) throw error
}

export async function addComment(chapterId: string, body: string, stage?: Stage) {
  const { data: auth } = await client().auth.getUser()
  if (!auth.user) throw new Error('Sessão expirada.')
  const { error } = await client().from('comments').insert({ chapter_id: chapterId, body, stage: stage ?? null, author_id: auth.user.id })
  if (error) throw error
}

export async function uploadArtifact(input: ArtifactInput) {
  const key = `${input.chapterId}/${input.stage}/${crypto.randomUUID()}-${input.file.name}`
  const { error: uploadError } = await client().storage.from('scan-artifacts').upload(key, input.file, { upsert: false })
  if (uploadError) throw uploadError
  const { data, error } = await client().rpc('register_artifact', {
    p_chapter_id: input.chapterId,
    p_stage: input.stage,
    p_provider: 'supabase',
    p_provider_key: key,
    p_original_name: input.file.name,
    p_mime_type: input.file.type || null,
    p_byte_size: input.file.size,
    p_note: input.note ?? null,
  })
  if (error) throw error
  return data
}

export function subscribeToProduction(onChange: () => void): RealtimeChannel | null {
  if (!supabase) return null
  return supabase.channel('production-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chapter_stages' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'artifacts' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, onChange)
    .subscribe()
}
