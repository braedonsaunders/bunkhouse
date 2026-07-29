'use client'

import * as React from 'react'
import Link from 'next/link'
import { Loader2, Play, Square } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  SearchSelect,
  Select,
} from '@appkit/ui'
import type { BunkhouseVoiceConfig } from '../db/schema'
import { listVoicesForTenantAction } from '../app/admin/settings/actions'
import { setAgentExtensionAction } from '../app/admin/settings/pbx-actions'
import { setAgentVoiceConfig } from '../app/organization/actions'
import { previewVoiceSampleAction, type VoicePreviewRequest } from '../app/organization/voice-preview-actions'

export type VoiceCatalogOption = { id: string; name: string; hint?: string }

export type RealtimeProviderOption = { slug: string; label: string; kind: 'openai' | 'google' }

/**
 * The agent's voice, as HR config: how it hears, thinks, and speaks on a call.
 * Realtime is the default — one speech-to-speech model on an OpenAI or Google
 * key, which is what a caller actually wants to hear: no relay latency and a
 * voice that can be interrupted. Cascade keeps the agent's own governed model
 * in the loop instead, at the cost of a hearing-thinking-speaking hop, and is
 * the fallback when no realtime-capable key is connected.
 */
export function VoiceConfigForm({
  personId,
  name,
  current,
  realtimeProviders,
  speechConfigured,
  cascadeModelSupported,
  extension,
  catalogs,
}: {
  personId: string
  name: string
  current: BunkhouseVoiceConfig | null
  realtimeProviders: RealtimeProviderOption[]
  speechConfigured: { deepgram: boolean; elevenlabs: boolean }
  /** Whether this agent's assigned model can hold a cascade call (resolved
   *  server-side from its provider). When false, the cascade combo is not
   *  offered — realtime remains fully available. */
  cascadeModelSupported: boolean
  /** The agent's phone-system extension ('' when unassigned). */
  extension: string
  catalogs: {
    deepgramSttModels: VoiceCatalogOption[]
    elevenLabsTtsModels: VoiceCatalogOption[]
    openaiRealtimeModels: VoiceCatalogOption[]
    openaiRealtimeVoices: VoiceCatalogOption[]
    geminiLiveModels: VoiceCatalogOption[]
    geminiLiveVoices: VoiceCatalogOption[]
  }
}) {
  // Realtime unless the tenant has no OpenAI/Google key to run it on — an
  // unconfigured agent should open on the mode we want people to use, not be
  // parked on one they cannot run.
  const [mode, setMode] = React.useState<'cascade' | 'realtime'>(
    current?.mode ?? (realtimeProviders.length > 0 || !cascadeModelSupported ? 'realtime' : 'cascade'),
  )
  const [sttModel, setSttModel] = React.useState(current?.cascade?.sttModel ?? catalogs.deepgramSttModels[0]?.id ?? '')
  const [ttsVoiceId, setTtsVoiceId] = React.useState(current?.cascade?.ttsVoiceId ?? '')
  const [ttsModel, setTtsModel] = React.useState(current?.cascade?.ttsModel ?? catalogs.elevenLabsTtsModels[0]?.id ?? '')
  // A new agent starts on OpenAI Realtime where the company has a key for it:
  // measured on this deployment it answers in well under a second, where
  // Gemini Live takes two to four — the difference between a colleague and a
  // pause. An operator can still choose either.
  const [realtimeKind, setRealtimeKind] = React.useState<'openai' | 'google'>(
    current?.realtime?.provider ??
      (realtimeProviders.some((p) => p.kind === 'openai') ? 'openai' : (realtimeProviders[0]?.kind ?? 'openai')),
  )
  const [realtimeModel, setRealtimeModel] = React.useState(current?.realtime?.model ?? '')
  const [realtimeVoice, setRealtimeVoice] = React.useState(current?.realtime?.voice ?? '')
  const [language, setLanguage] = React.useState(current?.language ?? 'en')
  const [style, setStyle] = React.useState(current?.style ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, startSaving] = React.useTransition()
  const [extensionDraft, setExtensionDraft] = React.useState(extension)
  const [extensionError, setExtensionError] = React.useState<string | null>(null)
  const [extensionSaved, setExtensionSaved] = React.useState(false)
  const [savingExtension, startSavingExtension] = React.useTransition()

  // The TTS voice list is live from the tenant's own ElevenLabs account.
  const [voices, setVoices] = React.useState<VoiceCatalogOption[] | null>(null)
  const [voicesError, setVoicesError] = React.useState<string | null>(null)
  const [voicesLoading, startVoicesLoading] = React.useTransition()
  React.useEffect(() => {
    if (mode !== 'cascade' || !speechConfigured.elevenlabs) return
    startVoicesLoading(async () => {
      setVoicesError(null)
      const result = await listVoicesForTenantAction()
      if (!result.ok) {
        setVoices(null)
        setVoicesError(result.message)
        return
      }
      setVoices(result.voices)
    })
  }, [mode, speechConfigured.elevenlabs])

  // Voice preview: one sample plays at a time; samples are cached per session
  // so replaying a voice never regenerates it.
  const [preview, setPreview] = React.useState<{ key: string; phase: 'loading' | 'playing' } | null>(null)
  const [previewError, setPreviewError] = React.useState<{ key: string; message: string } | null>(null)
  const previewCache = React.useRef(new Map<string, string>())
  const previewAudio = React.useRef<HTMLAudioElement | null>(null)
  const previewToken = React.useRef(0)

  const stopPreview = React.useCallback(() => {
    previewToken.current += 1
    previewAudio.current?.pause()
    previewAudio.current = null
    setPreview(null)
  }, [])
  React.useEffect(() => stopPreview, [stopPreview])

  // A changed selection hides its preview button, so end the playback with it.
  const resetPreview = () => {
    stopPreview()
    setPreviewError(null)
  }

  const togglePreview = (key: string, request: VoicePreviewRequest) => {
    if (preview?.key === key) {
      stopPreview()
      return
    }
    stopPreview()
    setPreviewError(null)
    const token = previewToken.current
    const play = (url: string) => {
      if (previewToken.current !== token) return
      const audio = new Audio(url)
      previewAudio.current = audio
      audio.onended = () => {
        if (previewToken.current === token) setPreview(null)
      }
      audio.onerror = () => {
        if (previewToken.current !== token) return
        setPreview(null)
        setPreviewError({ key, message: 'The sample could not be played.' })
      }
      setPreview({ key, phase: 'playing' })
      void audio.play().catch(() => {
        if (previewToken.current !== token) return
        setPreview(null)
        setPreviewError({ key, message: 'The sample could not be played.' })
      })
    }
    const cached = previewCache.current.get(key)
    if (cached) {
      play(cached)
      return
    }
    setPreview({ key, phase: 'loading' })
    void previewVoiceSampleAction(request).then((result) => {
      if (previewToken.current !== token) return
      if (!result.ok) {
        setPreview(null)
        setPreviewError({ key, message: result.message })
        return
      }
      previewCache.current.set(key, result.url)
      play(result.url)
    })
  }

  const previewButton = (key: string, request: VoicePreviewRequest, disabled: boolean) => {
    const active = preview?.key === key
    const loading = active && preview.phase === 'loading'
    const playing = active && preview.phase === 'playing'
    return (
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0"
        disabled={disabled || loading}
        aria-label={playing ? 'Stop voice preview' : 'Play voice preview'}
        title={disabled ? 'Pick a voice first.' : playing ? 'Stop preview' : 'Preview this voice'}
        onClick={() => togglePreview(key, request)}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : playing ? (
          <Square className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </Button>
    )
  }

  const realtimeModels = realtimeKind === 'openai' ? catalogs.openaiRealtimeModels : catalogs.geminiLiveModels
  const realtimeVoices = realtimeKind === 'openai' ? catalogs.openaiRealtimeVoices : catalogs.geminiLiveVoices

  const summary =
    current === null
      ? null
      : current.mode === 'cascade'
        ? `Cascade · hears with Deepgram ${current.cascade?.sttModel ?? ''} · speaks with ElevenLabs ${current.cascade?.ttsModel ?? ''}`
        : `Realtime · ${current.realtime?.provider === 'google' ? 'Gemini Live' : 'OpenAI Realtime'} ${current.realtime?.model ?? ''} · voice ${current.realtime?.voice ?? ''}`

  const toOptions = (items: VoiceCatalogOption[]) =>
    items.map((item) => ({ value: item.id, label: item.hint ? `${item.name} — ${item.hint}` : item.name }))

  const save = () =>
    startSaving(async () => {
      setError(null)
      const config: BunkhouseVoiceConfig =
        mode === 'cascade'
          ? {
              mode,
              language: language.trim() || 'en',
              ...(style.trim() ? { style: style.trim() } : {}),
              cascade: {
                sttProvider: 'deepgram',
                sttModel,
                ttsProvider: 'elevenlabs',
                ttsVoiceId,
                ttsModel,
              },
            }
          : {
              mode,
              language: language.trim() || 'en',
              ...(style.trim() ? { style: style.trim() } : {}),
              realtime: { provider: realtimeKind, model: realtimeModel, voice: realtimeVoice },
            }
      const result = await setAgentVoiceConfig({ personId, config })
      if (!result.ok) setError(result.message)
    })

  const clear = () =>
    startSaving(async () => {
      setError(null)
      const result = await setAgentVoiceConfig({ personId, config: null })
      if (!result.ok) setError(result.message)
    })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Voice
            {current ? <Badge variant="default">configured</Badge> : <Badge variant="outline">not configured</Badge>}
          </CardTitle>
          <CardDescription>
            {summary ??
              'Voice not configured — pick how this agent hears and speaks, then the Call button at the top of this record lights up.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="voice-mode">Mode</Label>
            <Select
              id="voice-mode"
              value={mode}
              onChange={(e) => {
                resetPreview()
                setMode(e.target.value as 'cascade' | 'realtime')
              }}
            >
              <option value="realtime">Realtime — one speech-to-speech model (OpenAI or Google key)</option>
              <option value="cascade" disabled={!cascadeModelSupported && mode !== 'cascade'}>
                Cascade — their own model thinks; Deepgram hears, ElevenLabs speaks
              </option>
            </Select>
            {!cascadeModelSupported ? (
              <p className="text-xs text-fg-muted">
                Voice calls in cascade mode are available for agents running OpenAI-compatible models. Choose realtime
                mode for this agent, or assign an OpenAI-compatible model on the Overview tab.
              </p>
            ) : null}
          </div>

          {mode === 'cascade' ? (
            <div className="space-y-4">
              {!speechConfigured.deepgram || !speechConfigured.elevenlabs ? (
                <EmptyState
                  title="Speech providers missing"
                  description={`Cascade calls need ${[
                    !speechConfigured.deepgram ? 'a Deepgram key (hearing)' : null,
                    !speechConfigured.elevenlabs ? 'an ElevenLabs key (speaking)' : null,
                  ]
                    .filter(Boolean)
                    .join(' and ')}. Add ${!speechConfigured.deepgram && !speechConfigured.elevenlabs ? 'them' : 'it'} in Settings → Voice.`}
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link href="/admin/settings">Open Settings</Link>
                    </Button>
                  }
                />
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Hearing (Deepgram STT model)</Label>
                  <SearchSelect
                    value={sttModel}
                    onChange={setSttModel}
                    options={toOptions(catalogs.deepgramSttModels)}
                    placeholder="Pick an STT model"
                    ariaLabel="STT model"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Speaking (ElevenLabs TTS model)</Label>
                  <SearchSelect
                    value={ttsModel}
                    onChange={setTtsModel}
                    options={toOptions(catalogs.elevenLabsTtsModels)}
                    placeholder="Pick a TTS model"
                    ariaLabel="TTS model"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Their voice</Label>
                {!speechConfigured.elevenlabs ? (
                  <p className="text-sm text-fg-muted">
                    The voice catalog comes from your own ElevenLabs account — add its key in Settings → Voice to pick
                    one.
                  </p>
                ) : voicesLoading ? (
                  <p className="text-sm text-fg-muted">Loading voices from your ElevenLabs account…</p>
                ) : voicesError ? (
                  <p className="text-sm text-danger">{voicesError}</p>
                ) : voices && voices.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    Your ElevenLabs account has no voices yet — add one there, then come back.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <SearchSelect
                        value={ttsVoiceId}
                        onChange={(value) => {
                          resetPreview()
                          setTtsVoiceId(value)
                        }}
                        options={toOptions(voices ?? [])}
                        placeholder="Pick a voice"
                        disabled={voices === null}
                        ariaLabel="TTS voice"
                        className="min-w-64 flex-1"
                      />
                      {previewButton(
                        `elevenlabs:${ttsVoiceId}`,
                        { source: 'elevenlabs', voiceId: ttsVoiceId, model: ttsModel },
                        !ttsVoiceId,
                      )}
                    </div>
                    {previewError?.key === `elevenlabs:${ttsVoiceId}` ? (
                      <p className="text-sm text-danger">{previewError.message}</p>
                    ) : null}
                  </>
                )}
              </div>

            </div>
          ) : (
            <div className="space-y-4">
              {realtimeProviders.length === 0 ? (
                <EmptyState
                  title="No realtime-capable provider"
                  description="Realtime voice runs on your OpenAI or Google Model provider keys. Add one under Settings → Model providers."
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link href="/admin/settings">Open Settings</Link>
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="voice-realtime-provider">Provider</Label>
                    <Select
                      id="voice-realtime-provider"
                      value={realtimeKind}
                      onChange={(e) => {
                        resetPreview()
                        setRealtimeKind(e.target.value as 'openai' | 'google')
                        setRealtimeModel('')
                        setRealtimeVoice('')
                      }}
                    >
                      {/* OpenAI first: it is the one that answers instantly, and
                          the order of a list is advice an operator reads. */}
                      {[...new Map(realtimeProviders.map((p) => [p.kind, p])).values()]
                        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'openai' ? -1 : 1))
                        .map((p) => (
                          <option key={p.kind} value={p.kind}>
                            {p.label} ({p.kind === 'openai' ? 'OpenAI Realtime' : 'Gemini Live'})
                          </option>
                        ))}
                    </Select>
                    <p className="text-xs text-fg-subtle">
                      OpenAI Realtime answers fastest on a live call — Gemini voices take a noticeable pause before
                      speaking.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Model</Label>
                      <SearchSelect
                        value={realtimeModel}
                        onChange={setRealtimeModel}
                        options={toOptions(realtimeModels)}
                        placeholder="Pick a model"
                        ariaLabel="Realtime model"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Voice</Label>
                      <div className="flex items-center gap-2">
                        <SearchSelect
                          value={realtimeVoice}
                          onChange={(value) => {
                            resetPreview()
                            setRealtimeVoice(value)
                          }}
                          options={toOptions(realtimeVoices)}
                          placeholder="Pick a voice"
                          ariaLabel="Realtime voice"
                          className="flex-1"
                        />
                        {previewButton(
                          `${realtimeKind}:${realtimeVoice}`,
                          { source: realtimeKind, voice: realtimeVoice },
                          !realtimeVoice,
                        )}
                      </div>
                      {previewError?.key === `${realtimeKind}:${realtimeVoice}` ? (
                        <p className="text-sm text-danger">{previewError.message}</p>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-xs text-fg-muted">
                    Realtime voices see a shared screen in video meetings as standard — a still is put in front of the
                    model every twenty seconds, and every still is saved to the meeting record.
                  </p>
                </>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="voice-language">Language</Label>
              <Input
                id="voice-language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="en"
              />
              <p className="text-xs text-fg-muted">BCP-47 tag — en, en-AU, fr, es-MX…</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="voice-style">Speaking style</Label>
              <Input
                id="voice-style"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="warm, unhurried, plain-spoken"
              />
              <p className="text-xs text-fg-muted">Optional hint fed to the speech layer.</p>
            </div>
          </div>

          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={save}
              disabled={
                saving ||
                (mode === 'cascade'
                  ? !cascadeModelSupported || !sttModel || !ttsModel || !ttsVoiceId
                  : !realtimeModel || !realtimeVoice)
              }
            >
              {saving ? 'Saving…' : 'Save voice'}
            </Button>
            {current ? (
              <Button type="button" variant="outline" onClick={clear} disabled={saving}>
                Remove voice
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Phone extension
            {extension ? <Badge variant="default">{extension}</Badge> : <Badge variant="outline">unassigned</Badge>}
          </CardTitle>
          <CardDescription>
            Desk phones on the connected phone system reach {name.split(' ')[0]} by dialing this code. Manage the
            connection under Settings → Voice → Phone system.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="voice-extension">Extension</Label>
              <Input
                id="voice-extension"
                value={extensionDraft}
                onChange={(e) => {
                  setExtensionDraft(e.target.value)
                  setExtensionSaved(false)
                }}
                placeholder="701"
                className="w-32 tabular-nums"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={savingExtension || extensionDraft.trim() === extension}
              onClick={() =>
                startSavingExtension(async () => {
                  setExtensionError(null)
                  setExtensionSaved(false)
                  const result = await setAgentExtensionAction({ personId, extension: extensionDraft })
                  if (!result.ok) {
                    setExtensionError(result.message)
                    return
                  }
                  setExtensionSaved(true)
                })
              }
            >
              {savingExtension ? 'Saving…' : extensionDraft.trim() ? 'Save extension' : extension ? 'Clear extension' : 'Save extension'}
            </Button>
          </div>
          <p className="text-xs text-fg-muted">2–6 digits, unique across the company. Leave blank and save to unassign.</p>
          {extensionError ? <p className="text-sm text-danger">{extensionError}</p> : null}
          {extensionSaved ? <p className="text-sm text-fg-muted">Saved.</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
