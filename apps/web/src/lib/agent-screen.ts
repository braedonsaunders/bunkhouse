/**
 * The agent's screen, as a live video track.
 *
 * Three sides share this contract and nothing else: the voice agent process
 * that publishes the track into the call's room, the desk session that feeds
 * it frames, and the call page that renders it. It is deliberately
 * dependency-free — a client component imports it without pulling in
 * puppeteer, sharp, or the LiveKit node SDK, and the constants stay a single
 * source of truth rather than three copies that drift.
 *
 * Why a real track at all: the caller is meant to watch the agent work the way
 * they would watch a colleague share a screen — the page scrolling, the cursor
 * moving, the text going in a character at a time. A still per recorded step
 * cannot be that, however often it is polled. The agent is already in the
 * room; publishing what its desk shows costs no new transport, no new
 * infrastructure, and no polling at all.
 *
 * The screenshot ledger is untouched by any of this. It is the audit record —
 * doctrine #9 — and it is what the run record replays afterwards. The track is
 * the live view; the ledger is the evidence.
 */

/**
 * The LiveKit track name the agent's desk is published under.
 *
 * The track's *source* is ScreenShare, chosen deliberately: it genuinely is a
 * screen being shared, and a server that thinks a 1280-wide screen of small
 * text is a camera will degrade it like a talking head — resolution first —
 * which is exactly backwards for something whose whole content is legible text.
 *
 * A source alone cannot identify it, though. In a video meeting a human guest
 * shares their screen into the same room, as a remote participant, on the same
 * source. The name is what tells the two apart, so the call stage can show the
 * agent's desk and never a guest's desktop.
 */
export const AGENT_SCREEN_TRACK_NAME = 'agent-desk'

/**
 * The size the agent's desk runs at, and therefore the size the track is
 * published at: one number for the browser viewport and for the compositor
 * when a desktop screen is opened, so the capture never rescales in the
 * ordinary case and the published frame is the screen pixel for pixel.
 * 64:45 — the call stage's own aspect, so the desk fills the stage without
 * letterboxing.
 */
export const AGENT_SCREEN_WIDTH = 1280
export const AGENT_SCREEN_HEIGHT = 900

/**
 * Frames per second put on the wire. Ten is the point where a page being
 * scrolled and a cursor crossing it read as motion rather than as a slideshow,
 * while a still screen — which is what a desk shows most of the time — costs
 * nothing at all, because the capture is damage-driven: Chromium's screencast
 * and the compositor's screencopy both emit a frame only when something
 * actually repainted.
 */
export const AGENT_SCREEN_FPS = 10
