'use client'

import { Badge } from '@appkit/ui'
import type { ProcedureContent } from '../db/schema'

/**
 * A revision as an agent receives it: the trigger, the numbered steps with their
 * human-check gates, the finish line, and the escalation rule. Revisions
 * written before procedures had steps show their original prose instead.
 */
export function ProcedureReader({ content, body }: { content: ProcedureContent | null; body: string }) {
  if (!content) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-fg-muted">Written before procedures had steps — edit it to break it into steps.</p>
        <div className="rounded-lg border border-border bg-surface p-4 text-sm whitespace-pre-wrap">{body}</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {content.whenToUse ? (
        <Section label="When to use this">
          <p className="text-sm">{content.whenToUse}</p>
        </Section>
      ) : null}

      <Section label={`Steps (${content.steps.length})`}>
        <ol className="space-y-2">
          {content.steps.map((step, index) => (
            <li key={step.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-start gap-3">
                <Badge variant="secondary" className="mt-0.5 shrink-0 tabular-nums">
                  {index + 1}
                </Badge>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">{step.title}</p>
                  {step.detail ? <p className="text-sm whitespace-pre-wrap text-fg-muted">{step.detail}</p> : null}
                  {step.checkWithHuman ? (
                    <Badge variant="outline">asks a human before carrying on</Badge>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {content.successCriteria.length > 0 ? (
        <Section label="Done when">
          <ul className="space-y-1 text-sm">
            {content.successCriteria.map((criterion, index) => (
              <li key={index} className="flex gap-2">
                <span className="text-fg-subtle">·</span>
                {criterion}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {content.escalation ? (
        <Section label="Stop and escalate when">
          <p className="text-sm">{content.escalation}</p>
        </Section>
      ) : null}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
      {children}
    </div>
  )
}
