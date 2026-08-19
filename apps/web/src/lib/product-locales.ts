import {
  DEFAULT_LOCALE,
  LOCALE_OPTIONS,
  normalizeLocalePolicy,
  type AppLocale,
} from '@braedonsaunders/appkit-i18n'

export { DEFAULT_LOCALE, LOCALE_OPTIONS, type AppLocale }

export type LocalePolicy = {
  defaultLocale: AppLocale
  enabledLocales: AppLocale[]
}

export const DEFAULT_LOCALE_POLICY: LocalePolicy = {
  defaultLocale: DEFAULT_LOCALE,
  enabledLocales: [DEFAULT_LOCALE],
}

export function resolveLocalePolicy(value: unknown): LocalePolicy {
  if (!value || typeof value !== 'object') return DEFAULT_LOCALE_POLICY
  const candidate = value as { defaultLocale?: unknown; enabledLocales?: unknown }
  return normalizeLocalePolicy({
    defaultLocale: candidate.defaultLocale,
    enabledLocales: Array.isArray(candidate.enabledLocales) ? candidate.enabledLocales : [],
  })
}

const EN = {
  'nav.home': 'Home',
  'nav.team': 'Team',
  'nav.agents': 'Agents',
  'nav.people': 'People',
  'nav.orgChart': 'Org chart',
  'nav.roles': 'Roles',
  'nav.work': 'Work',
  'nav.activity': 'Activity',
  'nav.approvals': 'Approvals',
  'nav.library': 'Library',
  'nav.settings': 'Settings',
  'account.signedIn': 'Signed in',
  'account.workspace': 'workspace',
  'account.workspacePicker': 'Workspace',
  'account.platformAdministration': 'Platform administration',
} as const

export type ProductMessageKey = keyof typeof EN
type ProductCatalogue = { [K in ProductMessageKey]: string }

export const PRODUCT_CATALOGUES = {
  en: EN,
  fr: {
    'nav.home': 'Accueil',
    'nav.team': 'Équipe',
    'nav.agents': 'Agents',
    'nav.people': 'Personnes',
    'nav.orgChart': 'Organigramme',
    'nav.roles': 'Rôles',
    'nav.work': 'Travail',
    'nav.activity': 'Activité',
    'nav.approvals': 'Approbations',
    'nav.library': 'Bibliothèque',
    'nav.settings': 'Paramètres',
    'account.signedIn': 'Connecté',
    'account.workspace': 'espace de travail',
    'account.workspacePicker': 'Espace de travail',
    'account.platformAdministration': 'Administration de la plateforme',
  },
  es: {
    'nav.home': 'Inicio',
    'nav.team': 'Equipo',
    'nav.agents': 'Agentes',
    'nav.people': 'Personas',
    'nav.orgChart': 'Organigrama',
    'nav.roles': 'Roles',
    'nav.work': 'Trabajo',
    'nav.activity': 'Actividad',
    'nav.approvals': 'Aprobaciones',
    'nav.library': 'Biblioteca',
    'nav.settings': 'Configuración',
    'account.signedIn': 'Sesión iniciada',
    'account.workspace': 'espacio de trabajo',
    'account.workspacePicker': 'Espacio de trabajo',
    'account.platformAdministration': 'Administración de la plataforma',
  },
} as const satisfies Record<AppLocale, ProductCatalogue>

export function productMessage(locale: AppLocale, key: ProductMessageKey): string {
  return PRODUCT_CATALOGUES[locale][key] ?? PRODUCT_CATALOGUES.en[key]
}
