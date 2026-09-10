import { chatThreadDetail } from './src/lib/chat-detail'
const TENANT = '52e8eec7-7698-4998-a3d4-7e1a13427061'
const THREAD = 'c9f230b2-b174-4f86-8983-a2ef10b22347'
const detail = await chatThreadDetail({ tenantId: TENANT, threadId: THREAD, canDecideApprovals: true })
if (!detail) throw new Error('no detail')
console.log('messages:', detail.messages.length)
console.log('dispatches pending:', detail.dispatches.map((d) => `${d.status}@${d.position}`).join(', '))
console.log('liveTurn:', detail.liveTurn === null ? 'NULL  <-- nothing to render' : JSON.stringify({
  runId: detail.liveTurn.runId.slice(0, 8),
  status: detail.liveTurn.status,
  activity: detail.liveTurn.activity.length,
  textChars: detail.liveTurn.text.length,
}))
