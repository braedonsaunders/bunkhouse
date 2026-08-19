'use client'

import * as React from 'react'
import { createHttpIamService } from '@braedonsaunders/appkit-iam/http'
import { AuditAdmin, RolesAdmin, UsersAdmin } from '@braedonsaunders/appkit-iam/react'
import type { ScopeOptions } from '@braedonsaunders/appkit-iam'
import { PERMISSION_GROUPS } from '../lib/permissions'
import { SectionTabs } from './section-tabs'
import type { AppLocale } from '../lib/product-locales'

const service = createHttpIamService({ endpoint: '/api/iam' })

export function AccessSettings({
  scopeOptions,
  locales,
}: {
  scopeOptions: ScopeOptions
  locales: Array<{ value: AppLocale; label: string }>
}) {
  const [tab, setTab] = React.useState('roles')
  return (
    <div className="space-y-4">
      <SectionTabs
        ariaLabel="Access control"
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'roles', label: 'Roles' },
          { key: 'members', label: 'Members' },
          { key: 'audit', label: 'Audit' },
        ]}
      />
      {tab === 'roles' ? (
        <RolesAdmin service={service} permissionGroups={[...PERMISSION_GROUPS]} scopeOptions={scopeOptions} />
      ) : null}
      {tab === 'members' ? (
        <UsersAdmin
          service={service}
          permissionGroups={[...PERMISSION_GROUPS]}
          scopeOptions={scopeOptions}
          locales={locales}
        />
      ) : null}
      {tab === 'audit' ? <AuditAdmin service={service} /> : null}
    </div>
  )
}
