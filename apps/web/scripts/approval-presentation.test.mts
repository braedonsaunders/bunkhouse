import assert from 'node:assert/strict'
import { approvalPresentation } from '../src/lib/approval-presentation'
import { replyTextForOutcome, shouldAppendPersistedAnswer } from '../src/lib/chat-reply'

const proposal = approvalPresentation({
  description: 'Create the connector.',
  action: {
    toolName: 'propose_system_integration',
    input: {
      name: 'SocialData X/Twitter Reader',
      slug: 'socialdata-twitter-reader',
      description: 'Read public posts for the morning market scan.',
      definition: {
        baseUrl: 'https://api.socialdata.tools',
        operations: [
          { name: 'search_tweets', title: 'Search public posts' },
          { name: 'get_user_tweets', title: 'Recent posts from a user' },
        ],
      },
    },
  },
})

assert.deepEqual(proposal.fields, [
  { label: 'Name', value: 'SocialData X/Twitter Reader' },
  { label: 'Identifier', value: 'socialdata-twitter-reader' },
  { label: 'Base URL', value: 'https://api.socialdata.tools' },
  { label: 'Abilities', value: 'Search public posts, Recent posts from a user' },
])
assert.equal(proposal.text, 'Read public posts for the morning market scan.')

const approvalReply = replyTextForOutcome({
  status: 'waiting_approval',
  approvalId: 'approval-1',
  usage: { inputTokens: 0, outputTokens: 0 },
  messages: [],
})
assert.match(approvalReply, /ready for your approval/i)
assert.match(approvalReply, /continue automatically/i)
assert.doesNotMatch(approvalReply, /colleague/i)

const credentialReply = replyTextForOutcome({
  status: 'waiting_credential',
  requestId: 'credential-1',
  usage: { inputTokens: 0, outputTokens: 0 },
  messages: [],
})
assert.match(credentialReply, /secure credential form/i)
assert.match(credentialReply, /continue automatically/i)
assert.match(credentialReply, /without putting the credential in this conversation/i)

assert.equal(
  shouldAppendPersistedAnswer('I have the provider mapped. Creating the proposal now.', approvalReply),
  true,
  'pre-tool progress cannot swallow the final approval handoff',
)
assert.equal(
  shouldAppendPersistedAnswer(`  ${approvalReply.replaceAll(' ', '  ')}  `, approvalReply),
  false,
  'the same answer with streaming whitespace is not duplicated',
)

console.log('approval presentation: exact action details and explicit conversational handoff')
