'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Checkbox, Input, Label } from '@appkit/ui'
import type { ProcedureContent, ProcedureStep } from '../db/schema'
import { MarkdownEditor } from './markdown-editor'

const ICON_BUTTON = 'h-7 w-7 px-0'

/** A blank step. Ids only need to be stable within one editing session. */
function blankStep(index: number): ProcedureStep {
  return { id: `step-${index}-${Math.random().toString(36).slice(2, 8)}`, title: '', detail: '', checkWithHuman: false }
}

export function emptyDraft(): ProcedureContent {
  return { whenToUse: '', steps: [blankStep(1)], successCriteria: [], escalation: '' }
}

/**
 * The step-by-step procedure editor: an ordered list of steps an operator can
 * add, reorder and delete, wrapped by the trigger, the finish line, and the
 * escalation rule. Emits its state as JSON on a hidden field, so a plain form
 * submit carries the whole structure.
 */
export function ProcedureEditor({
  name,
  value,
  onChange,
}: {
  name: string
  value: ProcedureContent
  onChange: (next: ProcedureContent) => void
}) {
  const set = (patch: Partial<ProcedureContent>) => onChange({ ...value, ...patch })
  const setStep = (id: string, patch: Partial<ProcedureStep>) =>
    set({ steps: value.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= value.steps.length) return
    const steps = [...value.steps]
    const [step] = steps.splice(index, 1)
    steps.splice(target, 0, step!)
    set({ steps })
  }

  return (
    <div className="space-y-5">
      <input type="hidden" name={name} value={JSON.stringify(value)} readOnly />

      <div className="space-y-2">
        <Label htmlFor="proc-when">When to use this</Label>
        <Input
          id="proc-when"
          value={value.whenToUse}
          onChange={(e) => set({ whenToUse: e.target.value })}
          placeholder="A customer asks for a refund outside the return window"
        />
        <p className="text-xs text-fg-muted">The trigger a hand matches against before following these steps.</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Steps</Label>
          <span className="text-xs text-fg-muted">{value.steps.length} step{value.steps.length === 1 ? '' : 's'}</span>
        </div>

        <div className="space-y-3">
          {value.steps.map((step, index) => (
            <div key={step.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-start gap-3">
                <Badge variant="secondary" className="mt-1.5 shrink-0 tabular-nums">
                  {index + 1}
                </Badge>
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    value={step.title}
                    onChange={(e) => setStep(step.id, { title: e.target.value })}
                    placeholder="What happens in this step"
                    aria-label={`Step ${index + 1} title`}
                  />
                  <MarkdownEditor
                    defaultValue={step.detail}
                    onChange={(detail) => setStep(step.id, { detail })}
                    placeholder="How to do it — the detail a new hire would need."
                    minHeight="120px"
                  />
                  <label className="flex w-fit items-center gap-2 text-sm text-fg-muted">
                    <Checkbox
                      checked={step.checkWithHuman}
                      onChange={(e) => setStep(step.id, { checkWithHuman: e.target.checked })}
                    />
                    Stop and ask a human before carrying on
                  </label>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON}
                    aria-label={`Move step ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON}
                    aria-label={`Move step ${index + 1} down`}
                    disabled={index === value.steps.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON}
                    aria-label={`Delete step ${index + 1}`}
                    disabled={value.steps.length === 1}
                    onClick={() => set({ steps: value.steps.filter((s) => s.id !== step.id) })}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set({ steps: [...value.steps, blankStep(value.steps.length + 1)] })}
        >
          <Plus size={14} /> Add step
        </Button>
      </div>

      <div className="space-y-2">
        <Label>Done when</Label>
        <p className="text-xs text-fg-muted">What must be true before a hand calls this finished.</p>
        <div className="space-y-2">
          {value.successCriteria.map((criterion, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={criterion}
                onChange={(e) =>
                  set({ successCriteria: value.successCriteria.map((c, i) => (i === index ? e.target.value : c)) })
                }
                placeholder="The customer has a written answer and the ticket is closed"
                aria-label={`Done when ${index + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={ICON_BUTTON}
                aria-label={`Remove condition ${index + 1}`}
                onClick={() => set({ successCriteria: value.successCriteria.filter((_, i) => i !== index) })}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set({ successCriteria: [...value.successCriteria, ''] })}
        >
          <Plus size={14} /> Add condition
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="proc-escalation">Stop and escalate when</Label>
        <Input
          id="proc-escalation"
          value={value.escalation}
          onChange={(e) => set({ escalation: e.target.value })}
          placeholder="The refund is over $500, or the customer disputes the charge"
        />
        <p className="text-xs text-fg-muted">Where the hand hands the work back to a person instead of finishing it.</p>
      </div>
    </div>
  )
}
