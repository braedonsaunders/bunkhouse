'use client'

import Link from 'next/link'
import { Brain, CheckCircle2, Mail, Shield, Users } from 'lucide-react'
import { AdminHub, type AdminHubGroup, type LinkRender } from '@appkit/ui'

const nextLink: LinkRender = ({ href, children, className, title }) => (
  <Link href={href} className={className} title={title}>
    {children}
  </Link>
)

const HUB_GROUPS: AdminHubGroup[] = [
  {
    label: 'Workforce',
    accent: 'teal',
    cards: [
      { href: '/people', title: 'Directory', description: 'Humans and hands, one org chart', icon: <Users size={18} /> },
      { href: '/people/hire', title: 'Hiring', description: 'Browse roles and extend offers', icon: <Mail size={18} /> },
      { href: '/approvals', title: 'Approvals', description: 'Actions waiting on human sign-off', icon: <CheckCircle2 size={18} /> },
    ],
  },
  {
    label: 'Company',
    accent: 'violet',
    cards: [
      { href: '/admin/settings', title: 'Settings', description: 'Model providers and company configuration', icon: <Brain size={18} /> },
      { href: '/people', title: 'Autonomy', description: 'Trust dials live on each hand’s profile', icon: <Shield size={18} /> },
    ],
  },
]

export default function AdminPage() {
  return (
    <AdminHub
      title="Administration"
      description="Run the bunkhouse: workforce, trust, and configuration."
      groups={HUB_GROUPS}
      linkRender={nextLink}
    />
  )
}
