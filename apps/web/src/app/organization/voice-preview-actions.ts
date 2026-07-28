'use server'

import { resolveTenantId } from '../../lib/tenant'
import { resolveRealtimeCredential, resolveSpeechCredential } from '../../lib/voice'

/**
 * Voice previews for the agent drawer's Voice tab: a short audio sample of the
 * currently selected voice, resolved server-side so provider keys stay sealed.
 *
 * - ElevenLabs voices ship a hosted preview clip; we return its URL.
 * - OpenAI realtime voices are sampled through the speech endpoint (the same
 *   voice names are shared with gpt-4o-mini-tts) and returned as an mp3 data URI.
 * - Gemini Live voices are sampled through the Gemini TTS model; the API
 *   returns raw PCM, which we wrap in a WAV header so the browser can play it.
 */
export type VoicePreviewRequest =
  | { source: 'elevenlabs'; voiceId: string }
  | { source: 'openai'; voice: string }
  | { source: 'google'; voice: string }

export type VoicePreviewResult = { ok: true; url: string } | { ok: false; message: string }

const SAMPLE_TEXT = "Hi, I'm your agent — this is how I sound."

/** OpenAI realtime-only voices that the speech endpoint cannot sample. */
const OPENAI_REALTIME_ONLY_VOICES = new Set(['cedar', 'marin'])

export async function previewVoiceSampleAction(request: VoicePreviewRequest): Promise<VoicePreviewResult> {
  const tenantId = await resolveTenantId()
  try {
    switch (request.source) {
      case 'elevenlabs':
        return await previewElevenLabsVoice(tenantId, request.voiceId)
      case 'openai':
        return await previewOpenAiVoice(tenantId, request.voice)
      case 'google':
        return await previewGoogleVoice(tenantId, request.voice)
      default:
        return { ok: false, message: 'Unknown voice source.' }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function previewElevenLabsVoice(tenantId: string, voiceId: string): Promise<VoicePreviewResult> {
  if (!voiceId) return { ok: false, message: 'Pick a voice first.' }
  const apiKey = await resolveSpeechCredential(tenantId, 'elevenlabs')
  if (apiKey === null) {
    return { ok: false, message: 'Add an ElevenLabs key under Settings → Voice to preview this voice.' }
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    return { ok: false, message: `ElevenLabs could not load this voice (${response.status}).` }
  }
  const json = (await response.json()) as { preview_url?: string | null }
  if (!json.preview_url) {
    return { ok: false, message: 'This voice has no preview clip in your ElevenLabs account.' }
  }
  return { ok: true, url: json.preview_url }
}

async function previewOpenAiVoice(tenantId: string, voice: string): Promise<VoicePreviewResult> {
  if (!voice) return { ok: false, message: 'Pick a voice first.' }
  const credential = await resolveRealtimeCredential(tenantId, 'openai')
  if (credential === null) {
    return { ok: false, message: 'Add an OpenAI provider under Settings → Model providers to preview this voice.' }
  }
  const baseUrl = (credential.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: SAMPLE_TEXT, response_format: 'mp3' }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    if (OPENAI_REALTIME_ONLY_VOICES.has(voice)) {
      return { ok: false, message: 'OpenAI offers this voice only on live realtime calls — no sample is available.' }
    }
    return { ok: false, message: `OpenAI could not generate a sample for this voice (${response.status}).` }
  }
  const audio = Buffer.from(await response.arrayBuffer())
  return { ok: true, url: `data:audio/mpeg;base64,${audio.toString('base64')}` }
}

async function previewGoogleVoice(tenantId: string, voice: string): Promise<VoicePreviewResult> {
  if (!voice) return { ok: false, message: 'Pick a voice first.' }
  const credential = await resolveRealtimeCredential(tenantId, 'google')
  if (credential === null) {
    return { ok: false, message: 'Add a Google provider under Settings → Model providers to preview this voice.' }
  }
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
    {
      method: 'POST',
      headers: { 'x-goog-api-key': credential.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: SAMPLE_TEXT }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok) {
    return { ok: false, message: `Google could not generate a sample for this voice (${response.status}).` }
  }
  const json = (await response.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[]
  }
  const inline = json.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData
  if (!inline?.data) {
    return { ok: false, message: 'Google returned no audio for this voice.' }
  }
  // Gemini TTS returns raw 16-bit mono PCM (rate in the mime type, 24kHz by
  // default) — browsers need a WAV container around it.
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24_000)
  const wav = pcmToWav(Buffer.from(inline.data, 'base64'), rate)
  return { ok: true, url: `data:audio/wav;base64,${wav.toString('base64')}` }
}

/** Wrap raw 16-bit mono PCM in a standard 44-byte RIFF/WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
