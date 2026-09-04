import { supabase } from './supabase'

export type StoredArtifact = { provider: string; provider_key: string; original_name: string; size_bytes: number; mime_type: string | null }
export interface StorageProvider { upload(path: string, file: File): Promise<StoredArtifact>; download(path: string): Promise<Blob>; delete(path: string): Promise<void>; getSignedUrl(path: string): Promise<string>; metadata(path: string): Promise<unknown> }

export class SupabaseStorageProvider implements StorageProvider {
  private bucket = 'scan-artifacts'
  private client() { if (!supabase) throw new Error('Supabase não configurado') ; return supabase }
  async upload(path: string, file: File): Promise<StoredArtifact> { const { error } = await this.client().storage.from(this.bucket).upload(path, file, { upsert: false }); if (error) throw error; return { provider: 'supabase', provider_key: path, original_name: file.name, size_bytes: file.size, mime_type: file.type || null } }
  async download(path: string) { const { data, error } = await this.client().storage.from(this.bucket).download(path); if (error) throw error; return data }
  async delete(path: string) { const { error } = await this.client().storage.from(this.bucket).remove([path]); if (error) throw error }
  async getSignedUrl(path: string) { const { data, error } = await this.client().storage.from(this.bucket).createSignedUrl(path, 300); if (error) throw error; return data.signedUrl }
  async metadata(path: string) { const { data, error } = await this.client().storage.from(this.bucket).list(path.split('/').slice(0, -1).join('/')); if (error) throw error; return data }
}

// TelegramStorageProvider must live behind an Edge Function/backend; never expose a bot token in this app.
export class TelegramStorageProvider implements StorageProvider { private unavailable(): never { throw new Error('Telegram Storage exige integração segura no backend/Edge Function') } async upload(): Promise<StoredArtifact> { return this.unavailable() } async download(): Promise<Blob> { return this.unavailable() } async delete(): Promise<void> { return this.unavailable() } async getSignedUrl(): Promise<string> { return this.unavailable() } async metadata(): Promise<unknown> { return this.unavailable() } }
