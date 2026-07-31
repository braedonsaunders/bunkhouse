'use client'

import { useRouter } from 'next/navigation'
import { Tabs } from '@appkit/ui'

const SECTIONS = [
  { value: 'agents', label: 'Agents', href: '/organization' },
  { value: 'people', label: 'People', href: '/organization/people' },
  { value: 'chart', label: 'Org chart', href: '/organization/chart' },
  { value: 'departments', label: 'Departments', href: '/organization/departments' },
] as const

export type OrganizationSection = (typeof SECTIONS)[number]['value']

/**
 * The organization's views on one switcher — the same control the
 * observatory uses for Live/History, navigating instead of toggling.
 */
export function OrganizationTabs({ active }: { active: OrganizationSection }) {
  const router = useRouter()
  return (
    <Tabs
      tabs={SECTIONS.map(({ value, label }) => ({ value, label }))}
      value={active}
      onValueChange={(value) => {
        const section = SECTIONS.find((entry) => entry.value === value)
        if (section && section.value !== active) router.push(section.href)
      }}
    />
  )
}
