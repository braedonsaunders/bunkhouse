'use server'

import { revalidatePath } from 'next/cache'
import { addAiProvider, removeAiProvider } from '../../lib/ai'
import { resolveTenantId } from '../../lib/tenant'

export async function addProviderAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase()
  const provider = String(formData.get('provider') ?? '')
  const label = String(formData.get('label') ?? '').trim() || slug
  const apiKey = String(formData.get('apiKey') ?? '').trim()
  const baseUrl = String(formData.get('baseUrl') ?? '').trim()
  const modelSmart = String(formData.get('modelSmart') ?? '').trim()
  const modelFast = String(formData.get('modelFast') ?? '').trim()
  if (!slug || !provider || !apiKey) throw new Error('Slug, provider kind, and API key are required.')

  const tenantId = await resolveTenantId()
  await addAiProvider({
    tenantId,
    slug,
    provider,
    label,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelSmart ? { modelSmart } : {}),
    ...(modelFast ? { modelFast } : {}),
  })
  revalidatePath('/settings')
}

export async function removeProviderAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '')
  if (!slug) throw new Error('slug is required')
  const tenantId = await resolveTenantId()
  await removeAiProvider(tenantId, slug)
  revalidatePath('/settings')
}
