'use client'

import * as React from 'react'
import { createHttpIamService } from '@appkit/iam/http'
import { AuditAdmin, RolesAdmin, UsersAdmin } from '@appkit/iam/react'
import { SubtabNav } from '@appkit/ui'
import type { ScopeOptions } from '@appkit/iam'
import { PERMISSION_GROUPS } from '../lib/permissions'

const service = createHttpIamService({ endpoint: '/api/iam' })

export function AccessSettings({ scopeOptions }: { scopeOptions: ScopeOptions }) {
  const [tab, setTab] = React.useState('roles')
  return (
    <div className="space-y-4">
      <SubtabNav
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
          locales={[{ value: 'en', label: 'English' }]}
        />
      ) : null}
      {tab === 'audit' ? <AuditAdmin service={service} /> : null}
    </div>
  )
}

