'use client'

import * as React from 'react'
import { Badge, Button, Input, Label, Select, SettingsRow, SettingsSection } from '@appkit/ui'
import {
  saveVoicePricingAction,
  saveVoiceRetentionAction,
  sweepRecordingsNowAction,
} from '../app/admin/settings/voice-actions'

/**
 * Call costs and call recordings — the money and the housekeeping side of
 * voice, in one section. Prices come from the company's own agreements with
 * its speech providers; nothing here is supplied or marked up by bunkhouse,
 * and a blank price means the minutes are recorded without a cost attached
 * rather than guessed at.
 */

export type VoiceCostSettingsView = {
  /** Days a recording is kept, or null to keep recordings indefinitely. */
  recordingDays: number | null
  deepgramUsdPerMinute: number | null
  elevenLabsUsdPerMinute: number | null
  realtimeUsdPerMinute: number | null
}

const asField = (value: number | null): string => (value === null ? '' : String(value))

export function VoiceCostSettings({ settings }: { settings: VoiceCostSettingsView }) {
  const [retentionOn, setRetentionOn] = React.useState(settings.recordingDays !== null)
  const [days, setDays] = React.useState(String(settings.recordingDays ?? 90))
  const [retentionNotice, setRetentionNotice] = React.useState<string | null>(null)
  const [retentionError, setRetentionError] = React.useState<string | null>(null)
  const [savingRetention, startSavingRetention] = React.useTransition()
  const [sweeping, startSweeping] = React.useTransition()

  const [deepgram, setDeepgram] = React.useState(asField(settings.deepgramUsdPerMinute))
  const [eleven, setEleven] = React.useState(asField(settings.elevenLabsUsdPerMinute))
  const [realtime, setRealtime] = React.useState(asField(settings.realtimeUsdPerMinute))
  const [pricingNotice, setPricingNotice] = React.useState<string | null>(null)
  const [pricingError, setPricingError] = React.useState<string | null>(null)
  const [savingPricing, startSavingPricing] = React.useTransition()

  const cascadePerMinute =
    deepgram.trim() || eleven.trim() ? (Number(deepgram || 0) + Number(eleven || 0)).toFixed(4) : null

  return (
    <SettingsSection
      title="Call costs & recordings"
      description="Every call an agent takes or places is recorded to your own storage, transcribed to the call ledger, and costed against that agent's salary. Set how long the audio is kept, and what a minute of speech costs your company."
    >
      <SettingsRow
        title="Recording retention"
        description={
          retentionOn
            ? `Recordings are deleted ${days} days after the call. Transcripts, runs and costs are kept.`
            : 'Recordings are kept indefinitely. Nothing is deleted unless you turn retention on.'
        }
        control={<Badge variant={retentionOn ? 'secondary' : 'outline'}>{retentionOn ? `${days} days` : 'kept'}</Badge>}
        stacked
      >
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
          <div className="space-y-1">
            <Label htmlFor="voice-retention-mode">Recordings</Label>
            <Select
              id="voice-retention-mode"
              value={retentionOn ? 'on' : 'off'}
              onChange={(event) => setRetentionOn(event.target.value === 'on')}
            >
              <option value="off">Keep indefinitely</option>
              <option value="on">Delete after a period</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="voice-retention-days">Days a recording is kept</Label>
            <Input
              id="voice-retention-days"
              type="number"
              min={1}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={!retentionOn}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          Only the audio is removed. The transcript, the run record, and what the call cost stay on the agent&apos;s
          calls tab permanently.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={savingRetention}
            onClick={() =>
              startSavingRetention(async () => {
                setRetentionError(null)
                setRetentionNotice(null)
                const result = await saveVoiceRetentionAction({
                  retentionEnabled: retentionOn,
                  recordingDays: Number(days),
                })
                if (!result.ok) setRetentionError(result.message)
                else {
                  setRetentionNotice(
                    retentionOn
                      ? `Saved — recordings are deleted after ${days} days.`
                      : 'Saved — recordings are kept indefinitely.',
                  )
                }
              })
            }
          >
            Save retention
          </Button>
          <Button
            variant="outline"
            disabled={sweeping || !retentionOn}
            title={retentionOn ? 'Delete recordings older than the window now.' : 'Turn retention on first.'}
            onClick={() =>
              startSweeping(async () => {
                setRetentionError(null)
                setRetentionNotice(null)
                const result = await sweepRecordingsNowAction()
                if (!result.ok) setRetentionError(result.message)
                else {
                  setRetentionNotice(
                    result.deleted === 0
                      ? 'Nothing to remove — no recording is older than the window.'
                      : `Removed ${result.deleted} recording${result.deleted === 1 ? '' : 's'}.`,
                  )
                }
              })
            }
          >
            {sweeping ? 'Applying…' : 'Apply now'}
          </Button>
          {retentionNotice ? <p className="text-sm text-fg-muted">{retentionNotice}</p> : null}
          {retentionError ? <p className="text-sm text-danger">{retentionError}</p> : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Speech rates"
        description="What one minute of call time costs you, per provider. Leave a rate blank and its minutes are still recorded — no cost is claimed for them."
        stacked
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="voice-price-deepgram">Deepgram — hearing ($/min)</Label>
            <Input
              id="voice-price-deepgram"
              inputMode="decimal"
              value={deepgram}
              onChange={(event) => setDeepgram(event.target.value)}
              placeholder="0.0077"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="voice-price-elevenlabs">ElevenLabs — speaking ($/min)</Label>
            <Input
              id="voice-price-elevenlabs"
              inputMode="decimal"
              value={eleven}
              onChange={(event) => setEleven(event.target.value)}
              placeholder="0.0900"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="voice-price-realtime">Speech-to-speech ($/min)</Label>
            <Input
              id="voice-price-realtime"
              inputMode="decimal"
              value={realtime}
              onChange={(event) => setRealtime(event.target.value)}
              placeholder="0.0600"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          {cascadePerMinute
            ? `An agent in cascade mode pays for hearing and speaking together — $${cascadePerMinute} a minute at these rates. An agent in realtime mode pays the speech-to-speech rate instead.`
            : 'An agent in cascade mode pays for hearing and speaking together; an agent in realtime mode pays the speech-to-speech rate instead.'}{' '}
          Model tokens are priced separately under Model pricing.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={savingPricing}
            onClick={() =>
              startSavingPricing(async () => {
                setPricingError(null)
                setPricingNotice(null)
                const result = await saveVoicePricingAction({
                  deepgramUsdPerMinute: deepgram,
                  elevenLabsUsdPerMinute: eleven,
                  realtimeUsdPerMinute: realtime,
                })
                if (!result.ok) setPricingError(result.message)
                else setPricingNotice('Saved — calls from now on are costed at these rates.')
              })
            }
          >
            Save rates
          </Button>
          {pricingNotice ? <p className="text-sm text-fg-muted">{pricingNotice}</p> : null}
          {pricingError ? <p className="text-sm text-danger">{pricingError}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
