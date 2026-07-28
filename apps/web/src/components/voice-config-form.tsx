'use client'

import * as React from 'react'
import Link from 'next/link'
import { Phone } from 'lucide-react'
import type { AgentVoiceConfig } from '@appkit/voice'
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
import { listVoicesForTenantAction } from '../app/admin/settings/actions'
import { setHandExtensionAction } from '../app/admin/settings/pbx-actions'
import { setHandVoiceConfig } from '../app/people/actions'

export type VoiceCatalogOption = { id: string; name: string; hint?: string }

export type RealtimeProviderOption = { slug: string; label: string; kind: 'openai' | 'google' }

/**
 * The hand's voice, as HR config: how it hears, thinks, and speaks on a call.
 * Cascade keeps the hand's own governed model in the loop (the doctrinal
 * default); realtime trades that for latency on an OpenAI/Google key.
 */
export function VoiceConfigForm({
  personId,
  name,
  status,
  current,
  realtimeProviders,
  speechConfigured,
  cascadeModelSupported,
  extension,
  catalogs,
}: {
  personId: string
  name: string
  status: string
  current: AgentVoiceConfig | null
  realtimeProviders: RealtimeProviderOption[]
  speechConfigured: { deepgram: boolean; elevenlabs: boolean }
  /** Whether this hand's assigned model can hold a cascade call (resolved
   *  server-side from its provider). When false, the cascade combo is not
   *  offered — realtime remains fully available. */
  cascadeModelSupported: boolean
  /** The hand's phone-system extension ('' when unassigned). */
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
  const [mode, setMode] = React.useState<'cascade' | 'realtime'>(
    current?.mode ?? (cascadeModelSupported ? 'cascade' : 'realtime'),
  )
  const [sttModel, setSttModel] = React.useState(current?.cascade?.sttModel ?? catalogs.deepgramSttModels[0]?.id ?? '')
  const [ttsVoiceId, setTtsVoiceId] = React.useState(current?.cascade?.ttsVoiceId ?? '')
  const [ttsModel, setTtsModel] = React.useState(current?.cascade?.ttsModel ?? catalogs.elevenLabsTtsModels[0]?.id ?? '')
  const [realtimeKind, setRealtimeKind] = React.useState<'openai' | 'google'>(
    current?.realtime?.provider ?? realtimeProviders[0]?.kind ?? 'openai',
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

  const realtimeModels = realtimeKind === 'openai' ? catalogs.openaiRealtimeModels : catalogs.geminiLiveModels
  const realtimeVoices = realtimeKind === 'openai' ? catalogs.openaiRealtimeVoices : catalogs.geminiLiveVoices

  const callable = current !== null && status === 'active'
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
      const config: AgentVoiceConfig =
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
      const result = await setHandVoiceConfig({ personId, config })
      if (!result.ok) setError(result.message)
    })

  const clear = () =>
    startSaving(async () => {
      setError(null)
      const result = await setHandVoiceConfig({ personId, config: null })
      if (!result.ok) setError(result.message)
    })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              Voice
              {current ? <Badge variant="default">configured</Badge> : <Badge variant="outline">not configured</Badge>}
            </span>
            {callable ? (
              <Button asChild>
                <Link href={`/call/${personId}`} prefetch={false}>
                  <Phone className="mr-1.5 size-4" /> Call {name.split(' ')[0]}
                </Link>
              </Button>
            ) : (
              <Button disabled title={current === null ? 'Configure a voice first.' : 'Only active hands take calls.'}>
                <Phone className="mr-1.5 size-4" /> Call {name.split(' ')[0]}
              </Button>
            )}
          </CardTitle>
          <CardDescription>
            {summary ??
              'Voice not configured — pick how this hand hears and speaks, then the Call button lights up.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="voice-mode">Mode</Label>
            <Select id="voice-mode" value={mode} onChange={(e) => setMode(e.target.value as 'cascade' | 'realtime')}>
              <option value="cascade" disabled={!cascadeModelSupported && mode !== 'cascade'}>
                Cascade — their own model thinks; Deepgram hears, ElevenLabs speaks
              </option>
              <option value="realtime">Realtime — one speech-to-speech model (OpenAI or Google key)</option>
            </Select>
            {!cascadeModelSupported ? (
              <p className="text-xs text-fg-muted">
                Voice calls in cascade mode are available for hands running OpenAI-compatible models. Choose realtime
                mode for this hand, or assign an OpenAI-compatible model on the Overview tab.
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
                  <SearchSelect
                    value={ttsVoiceId}
                    onChange={setTtsVoiceId}
                    options={toOptions(voices ?? [])}
                    placeholder="Pick a voice"
                    disabled={voices === null}
                    ariaLabel="TTS voice"
                    className="min-w-64"
                  />
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
                        setRealtimeKind(e.target.value as 'openai' | 'google')
                        setRealtimeModel('')
                        setRealtimeVoice('')
                      }}
                    >
                      {[...new Map(realtimeProviders.map((p) => [p.kind, p])).values()].map((p) => (
                        <option key={p.kind} value={p.kind}>
                          {p.label} ({p.kind === 'openai' ? 'OpenAI Realtime' : 'Gemini Live'})
                        </option>
                      ))}
                    </Select>
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
                      <SearchSelect
                        value={realtimeVoice}
                        onChange={setRealtimeVoice}
                        options={toOptions(realtimeVoices)}
                        placeholder="Pick a voice"
                        ariaLabel="Realtime voice"
                      />
                    </div>
                  </div>
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
                  const result = await setHandExtensionAction({ personId, extension: extensionDraft })
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
