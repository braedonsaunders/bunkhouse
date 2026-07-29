import type { EmailMergeField } from '@appkit/email-designer'

/**
 * The tokens a signature may use, with preview values. One design serves the
 * whole roster because these resolve per sender at send time — see
 * `signatureValues` in ./mail-signature, which must stay in step with this list.
 *
 * Kept apart from that module so the designer (a client component) can offer the
 * palette without pulling the server-only send path into the browser bundle.
 */
export const SIGNATURE_MERGE_FIELDS: EmailMergeField[] = [
  { key: 'agent.name', label: 'Name', sample: 'Dana Reid', group: 'Sender' },
  { key: 'agent.firstName', label: 'First name', sample: 'Dana', group: 'Sender' },
  { key: 'agent.title', label: 'Title', sample: 'Operations Lead', group: 'Sender' },
  { key: 'agent.email', label: 'Email', sample: 'dana@example.com', group: 'Sender' },
  { key: 'agent.phone', label: 'Phone', sample: '(555) 010-3311', group: 'Sender' },
  { key: 'agent.extension', label: 'Extension', sample: '204', group: 'Sender' },
  { key: 'company.name', label: 'Company', sample: 'Northwind Supply', group: 'Company' },
  { key: 'company.legalName', label: 'Legal name', sample: 'Northwind Supply Ltd.', group: 'Company' },
  { key: 'company.tagline', label: 'Tagline', sample: 'Built to last.', group: 'Company' },
  { key: 'company.website', label: 'Website', sample: 'https://example.com', group: 'Company' },
  { key: 'company.phone', label: 'Company phone', sample: '(555) 010-3300', group: 'Company' },
  { key: 'company.email', label: 'Company email', sample: 'hello@example.com', group: 'Company' },
  { key: 'company.address', label: 'Address', sample: '18 Harbour Rd, Kingston', group: 'Company' },
]
