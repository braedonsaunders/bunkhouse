import { llm, voice } from '@livekit/agents'

/**
 * The agent's eyes on a live call.
 *
 * A call's tools answer in text — the model reads what a tool returned, it
 * does not receive attachments — so anything the agent needs to *look* at has
 * to go into the chat context as an image between turns. There is one pair of
 * eyes per call, and everything that has a picture to show uses it: the
 * guest's shared screen in a video meeting, and the agent's own browser while
 * it works on the line.
 *
 * Whether a model takes images at all is not something anyone can know in
 * advance — not the runtime, and certainly not the operator configuring the
 * agent. So the answer is to try. Every picture is offered; if the model
 * refuses one, vision goes off for the rest of the call, the pictures already
 * offered come back out of the context so the next turn is not poisoned by
 * them, and the agent says plainly that it cannot see. That is one honest
 * failure per session, not a setting somebody has to guess at.
 *
 * Imported only by the voice agent process; the web app never bundles this.
 */

/** One picture, and what to say if it turns out the model cannot take it. */
export type AgentPicture = {
  /** The image as a data URL — what actually goes to the model. */
  dataUrl: string
  /** The line that goes with it in the agent's context. */
  caption: string
  /**
   * What the agent should tell the person on the line if this picture is the
   * one that reveals the model has no eyes. It travels with the picture
   * because a shared screen and the agent's own browser call for different
   * sentences.
   */
  ifRefused: string
}

export type AgentEyes = {
  /** True while pictures are still reaching the model. */
  active: () => boolean
  /**
   * Put one picture in front of the agent, between turns. A no-op once the
   * model has refused; a refusal discovered here switches vision off.
   */
  show: (picture: AgentPicture) => Promise<void>
  /**
   * The model would not take the picture — reported from here, or from the
   * session's own error stream on the next inference. Stops the pictures,
   * takes the ones already sent back out of the context so the following turn
   * can succeed, and has the agent say plainly that it cannot see.
   */
  refused: (message: string) => void
}

/**
 * Open the agent's eyes for one call.
 *
 * `sees` is the only thing decided in advance, and only where it is a genuine
 * transport fact rather than a guess: a realtime session that cannot take a
 * mid-flight context update has no way to be shown anything.
 */
export function openAgentEyes(args: {
  agent: voice.Agent
  session: voice.AgentSession
  /** False only when the session genuinely cannot carry an image at all. */
  sees: boolean
  /** Record the moment vision went off — this belongs on the run. */
  onBlind: (message: string) => void
  /**
   * About to make the agent speak. The eyes are the one place besides the
   * mailbox and the greeting that starts a turn of its own, and an utterance
   * whose cause is unrecorded reads on the record exactly like the agent
   * answering from stale context — the thing the trace exists to detect.
   */
  onSpeaking?: () => void
  /** Operator-facing log line for anything that goes wrong along the way. */
  onError: (message: string) => void
}): AgentEyes {
  const { agent, session, onBlind, onError } = args
  let visionOn = args.sees
  /** Context items holding a picture, so a refusal can retract every one. */
  const shownMessageIds = new Set<string>()
  /** What the agent should say if these pictures turn out not to arrive. */
  let lastRefusalLine = 'Tell them plainly, in one sentence, that you cannot see pictures on this call.'

  const refused = (message: string) => {
    if (!visionOn || shownMessageIds.size === 0) return
    visionOn = false
    onBlind(message)
    const instructions = lastRefusalLine
    // The refused pictures are still in the context; leave them there and
    // every following turn fails the same way.
    const chatCtx = agent.chatCtx.copy()
    chatCtx.items = chatCtx.items.filter((item) => !shownMessageIds.has(item.id))
    shownMessageIds.clear()
    void agent
      .updateChatCtx(chatCtx)
      .then(() => {
        args.onSpeaking?.()
        session.generateReply({ instructions })
      })
      .catch((error) => onError((error as Error).message))
  }

  return {
    active: () => visionOn,
    refused,
    show: async (picture) => {
      if (!visionOn) return
      lastRefusalLine = picture.ifRefused
      const chatCtx = agent.chatCtx.copy()
      const message = chatCtx.addMessage({
        role: 'user',
        content: [picture.caption, llm.createImageContent({ image: picture.dataUrl })],
      })
      try {
        await agent.updateChatCtx(chatCtx)
        shownMessageIds.add(message.id)
      } catch (error) {
        // Some models refuse image content the moment it is offered rather
        // than at inference time; either way the answer is the same.
        shownMessageIds.add(message.id)
        refused((error as Error).message)
      }
    },
  }
}
