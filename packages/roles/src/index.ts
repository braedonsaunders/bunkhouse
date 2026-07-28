import { arCollectionsClerk } from './packs/ar-collections-clerk'
import { customerServiceRep } from './packs/customer-service-rep'
import { officeAdministrator } from './packs/office-administrator'
import type { RolePack } from './types'

export type {
  ActionCategory,
  AutonomyLevel,
  RolePack,
  RolePackDuty,
  RolePackProcedure,
} from './types'
export { officeAdministrator, arCollectionsClerk, customerServiceRep }

/** The first-party hiring catalog, in display order. */
export const ROLE_PACKS: RolePack[] = [officeAdministrator, arCollectionsClerk, customerServiceRep]

export function getRolePack(slug: string): RolePack | undefined {
  return ROLE_PACKS.find((pack) => pack.slug === slug)
}
