'use client'

import * as React from 'react'
import { UserPlus } from 'lucide-react'
import { Button, Drawer, Input, Label, Select, Textarea } from '@appkit/ui'
import { addPerson } from '../app/organization/actions'

export type ManagerOption = { id: string; name: string; title: string }

/**
 * Add a real human to the organization. Agents are hired from a role pack —
 * this is the other half of the mixed roster, and the only way a human gets
 * onto the org chart, into escalation paths, and into the routing directory
 * every agent reads before it answers mail.
 */
export function AddPersonDrawer({ managers }: { managers: ManagerOption[] }) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" /> Add a person
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add a person"
        description="A real colleague. Agents route work to them by email and escalate to them by reporting line."
        size="lg"
      >
        <form action={addPerson} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="new-name">Name</Label>
            <Input id="new-name" name="name" required autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-title">Job title</Label>
            <Input id="new-title" name="title" required placeholder="Operations Manager" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-email">Work email</Label>
            <Input id="new-email" name="email" type="email" required autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-phone">Phone</Label>
            <Input id="new-phone" name="phone" type="tel" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-reports">Reports to</Label>
            <Select id="new-reports" name="reportsToId" defaultValue="">
              <option value="">— Top level —</option>
              {managers.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.name} — {manager.title}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-status">Status</Label>
            <Select id="new-status" name="status" defaultValue="active">
              <option value="active">Active</option>
              <option value="onboarding">Onboarding</option>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-timezone">Time zone</Label>
            <Input id="new-timezone" name="timezone" placeholder="America/New_York" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-started">Start date</Label>
            <Input id="new-started" name="startedOn" type="date" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-resp">What they own</Label>
            <Textarea
              id="new-resp"
              name="responsibilities"
              rows={3}
              placeholder="Scheduling, supplier relationships, anything touching the shop floor."
            />
            <p className="text-xs text-fg-muted">
              Agents read this to decide who a thread belongs to, so write it the way you would brief a new hire.
            </p>
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Button type="submit">Add to the organization</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  )
}
