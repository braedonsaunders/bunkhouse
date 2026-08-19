import 'server-only'
import { and, eq } from 'drizzle-orm'
import { resolveLocalePreferences, type AppLocale } from '@braedonsaunders/appkit-i18n'
import {
  COMPANY_LOCALE_KEY,
  tenantSettings,
  type CompanyLocaleSettings,
} from '../db/schema'
import { db } from '../db/client'
import { resolveLocalePolicy, type LocalePolicy } from './product-locales'

export type LocaleSettingsView = LocalePolicy & {
  updatedAt: string | null
}

export async function getLocaleSettings(tenantId: string): Promise<LocaleSettingsView> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value, updatedAt: tenantSettings.updatedAt })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, COMPANY_LOCALE_KEY)))
      .limit(1),
  )
  return {
    ...resolveLocalePolicy(row?.value),
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  }
}

export async function saveLocaleSettings(args: {
  tenantId: string
  actorId: string
  defaultLocale: unknown
  enabledLocales: readonly unknown[]
}): Promise<LocalePolicy> {
  const value = resolveLocalePolicy({
    defaultLocale: args.defaultLocale,
    enabledLocales: args.enabledLocales,
  }) satisfies CompanyLocaleSettings
  const app = db()
  await app.withTenant(args.tenantId, () =>
    app.db
      .insert(tenantSettings)
      .values({
        tenantId: args.tenantId,
        key: COMPANY_LOCALE_KEY,
        value,
        createdBy: args.actorId,
        updatedBy: args.actorId,
      })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value, updatedAt: new Date(), updatedBy: args.actorId },
      }),
  )
  return value
}

export async function effectiveLocale(args: {
  tenantId: string
  userLocale?: unknown
}): Promise<AppLocale> {
  const policy = await getLocaleSettings(args.tenantId)
  return resolveLocalePreferences({
    defaultLocale: policy.defaultLocale,
    enabledLocales: policy.enabledLocales,
    userLocale: args.userLocale,
  }).locale
}
