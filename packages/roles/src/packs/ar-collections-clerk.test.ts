import assert from 'node:assert/strict'
import { arCollectionsClerk } from './ar-collections-clerk'

assert.equal(arCollectionsClerk.autonomyDefaults.external_email, 'approval')
assert.equal(arCollectionsClerk.autonomyDefaults.money_adjacent, 'forbidden')
assert.equal(arCollectionsClerk.inboundPolicy, 'anyone')
assert.ok(arCollectionsClerk.duties.length >= 3)
assert.equal(new Set(arCollectionsClerk.duties.map((duty) => duty.slug)).size, arCollectionsClerk.duties.length)

const procedures = arCollectionsClerk.procedures.map((procedure) => procedure.body).join('\n').toLowerCase()
for (const required of ['day 1', 'day 15', 'day 30', 'day 60', 'dispute', 'manager approval']) {
  assert.ok(procedures.includes(required), `AR controls must mention ${required}`)
}
assert.match(procedures, /never threaten collections or legal action/)
assert.match(procedures, /never negotiate a discount/)

console.log('AR collections role: cadence, dispute escalation, and day-one autonomy controls verified')
