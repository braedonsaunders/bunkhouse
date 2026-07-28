# The Desk — assignments, office documents, delivery, and the workspace (design, surveyed 2026-07-28)

Owner's epic: get on a call with an agent, describe office work — "research X and email me
a PDF / Word doc / spreadsheet" — hang up, and the finished file arrives in your inbox.
This is doctrine #7 ("real files, real storage") made real, plus the missing bridge
between a live call and asynchronous deep work. Second epic in the same slice family:
agents get a sandboxed **workspace** — their own desk: a persistent home directory that
survives across runs like a human's working folder, with shell execution recorded per
doctrine #9.

**Office capability source (owner's direction): look in beaconhs-platform first.** The
survey found its office stack is LibreOffice-headless (`soffice --convert-to`) + a
dependency-free Flat-ODT find/replace engine + ExcelJS + `pdfunite` — no JS docx library
at all — and its AI doc agent authors HTML that LibreOffice converts to .docx. That
pattern (model writes HTML/specs, deterministic converters produce bytes) is exactly
doctrine-shaped and is what `@appkit/office` generalizes.

## What the codebase survey established (2026-07-28)

**Already shipped and reusable as-is:**
- Voice calls (browser + inbound PBX) run the *full governed toolset* mid-call —
  `assembleAbilities` is shared by email runs, duty runs, and `governedCallTools`
  (`apps/web/src/lib/agent-abilities.ts`, `apps/web/src/lib/call-tools.ts`), with tool
  activity in the live transcript and human pacing (fillers, resume nudges).
- Research: `web_search` (Brave/Tavily/DDG fallback) + `read_webpage` (SSRF-guarded),
  in every run (`apps/web/src/lib/research.ts`).
- Email engine: IMAP/SMTP sync + send, threads/messages ledger, inbound-policy gating,
  approval-by-email-reply. `mail_messages.attachments` jsonb and `MailAttachmentRef`
  exist as deliberate seams — nothing writes them.
- Self-scheduling: `schedule_task` lets an agent park future work as a duty — today the
  *only* way work outlives a call.
- Governance: `governedToolSet` dial enforcement, `file_write` category fully plumbed
  in schema/UI with **zero abilities carrying it**.

**Absent (no code anywhere):** document generation (.docx/.xlsx/.pdf), any use of
`@appkit/storage` (declared, never imported; no MinIO in compose), outbound mail
attachments (`SendMailArgs` has no attachments field — upstream appkit change),
delegation tool, background/resumable runs, generic approval execution.

**Broken seams that block this epic specifically:**
1. **Approved actions don't execute.** `worker.mts` special-cases `reply_to_thread`
   only; every other approved action records "no automatic executor" and completes the
   run. `RunAgentArgs.priorMessages` exists for resumption but has no caller.
2. **Call-time approvals dead-end.** The call's run is `completed` at hangup;
   `approvalsPass` only resumes `waiting_approval` runs, so a mid-call "I'll queue that
   for sign-off" is a promise the system cannot keep.
3. **Runs are synchronous and capped.** One `generateText`, `stepCountIs(24)`, executed
   inline in the worker tick. No continuation, no checkpoint, no sub-agents.
4. **Web calls don't know the caller.** `/call/[personId]` hardcodes
   `{name:'Demo Owner', identity:'human:owner'}` although auth now exists — so "email
   *me* the file" has no reliable "me". Also: a session+run per page load, no reaper.
5. `notify` autonomy level is behaviorally identical to `trusted` (doc comment promises
   a manager-feed event; none is recorded).

## Core decisions

1. **A deliverable is a file record.** New `files` table (RLS): id, tenant, owner
   person, run, filename, contentType, size, storage key, kind
   (`document|spreadsheet|attachment|recording|upload`), sha256, created_at.
   Append-only; every generated artifact and every mail attachment is a row. Object
   storage is `@appkit/storage` (S3/MinIO — already vendored, key helpers ready);
   MinIO joins dev + deploy compose. The S3 backend is deployment infra (env);
   *connected* storage (Drive/OneDrive/SMB filing) is a later tenant integration.
2. **The model authors specs, renderers produce bytes.** Never let the model emit raw
   OOXML. New AppKit package **`@appkit/office`** (backfill per AGENTS.md rule 2):
   - `.docx` via the `docx` npm library from a markdown+blocks document spec
     (headings, paragraphs, tables, lists, images, page breaks) + tenant letterhead;
   - `.xlsx` via `exceljs` from a sheet spec (columns with types/formats, rows,
     real formulas, autofilter, widths, multiple sheets);
   - `.pdf` via the existing `@appkit/pdf` HTML template engine (same document spec,
     one HTML renderer, Chromium path already exists in `@appkit/forms-pdf`).
   Deterministic input → output; branding applied by the renderer, not the model.
3. **Abilities carry `file_write`.** `create_document` (docx|pdf) and
   `create_spreadsheet` (xlsx) are the first abilities in that category — the dial
   finally governs something. Output lands in `files` + storage, is referenced by id,
   and renders as a card in the run desk and call transcript.
4. **Attachments ride the existing rails.** Upstream `@appkit/mailbox` change:
   `SendMailArgs.attachments?: {filename, contentType, content}[]` (nodemailer
   supports it natively); re-vendor. `send_email` / `email_colleague` /
   `reply_to_thread` gain `attachFileIds`. Inbound: `saveInbound` persists parsed
   attachment buffers to storage and writes `mail_messages.attachments` (the seam
   comment at `mailbox.ts:133` finally pays off). Mail thread UI renders both.
5. **An assignment is a commitment, not a schedule.** New `assignments` table: tenant,
   person, source (`call:<sessionId>` | `mail:<threadId>` | `manual`), spec (rich
   text), requested formats, deliver-to (directory person or external address),
   due_at, status `pending|working|waiting_approval|delivered|failed|cancelled`,
   result file ids, delivered message id, linked run id. Duties = recurring schedule;
   assignments = one deliverable with a deadline and a recipient. Append-only status
   history via run events.
6. **Deep work runs in the background and can resume.** Run execution moves to real
   BullMQ jobs (per-run job, bounded concurrency) instead of inline awaits in the
   heartbeat tick. The run persists its AI-SDK message transcript at suspension;
   `priorMessages` (already designed into `runAgent`) gets its first caller:
   - generic approval executor: approval decided → re-enqueue the run with the
     transcript + approved/declined tool result appended; delete the
     `reply_to_thread` special case;
   - step budget becomes per-run config (assignment runs get a higher ceiling and
     may continue across multiple model calls), still hard-capped and metered
     against salary per doctrine #5.
7. **`take_assignment` is the call→work bridge.** Ungoverned-to-create (creating a
   commitment is like scheduling), governed at delivery time by `external_email` /
   `file_write` dials as the work actually executes. On a call the agent captures
   spec, formats, recipient, deadline; confirms verbally; the assignment row enqueues
   a background run that starts immediately and survives hangup. Approval-needing
   steps park the run `waiting_approval` — now actually resumable (decision 6) — and
   the assignment surfaces the wait. Same tool works from email runs ("I'll get that
   to you by Friday") and delegation.
8. **Calls know who called.** `/call/[personId]` uses the authenticated session user
   for identity/name; the assignment's default deliver-to is the caller's directory
   record. Session+run creation moves behind an explicit connect action (no more
   orphan rows per page refresh); a reaper fails sessions whose worker never joined.

## Schema (to become migrations when built)

files(id, tenant_id, person_id, run_id, kind, filename, content_type, size_bytes,
  storage_key, sha256, created_at)  -- append-only
assignments(id, tenant_id, person_id, source jsonb, spec_richtext, formats text[],
  deliver_to jsonb, due_at, status, run_id, result_file_ids uuid[],
  delivered_message_id, created_at, updated_at)
mail_messages.attachments  -- existing jsonb seam, now written
runs + transcript jsonb NULLABLE  -- persisted AI-SDK messages at suspension
tenant_settings 'documents.branding'  -- logo file id, accent, letterhead footer,
  paper size, default fonts

## Build order (each slice ships its UI or it doesn't exist)

1. **The filing cabinet.** MinIO in dev+deploy compose; `@appkit/storage` wired via
   env; `files` table + RLS; inbound mail attachments persisted and rendered in the
   thread view; upstream `@appkit/mailbox` attachments change + re-vendor; outbound
   `attachFileIds` on the three mail abilities. UI: attachment chips in mail threads,
   files listed on the run desk.
   **SHIPPED:** MinIO in both composes (+ `minio-data` volume), `APPKIT_STORAGE_*`
   env, migration `0020_files` (`files` + RLS), `lib/files.ts` (sha256, tenant keys,
   `saveFile`/`getFileBytes`/`getFileStream`), `/api/files/[fileId]` download route
   (auth + tenant via resolveTenantId), `@appkit/mailbox` **0.2.0** with
   `SendMailArgs.attachments` (built + re-vendored), inbound attachments persisted in
   `makeStore.saveInbound` (25 MB cap per attachment), `attachFileIds` on
   `send_email` / `email_colleague` / `reply_to_thread`, attachment chips in the
   thread view.
2. **The typewriter.** `@appkit/office` built in the appkit repo — extracted from
   beaconhs `packages/office` (sofficeConvert, FODT find/replace, pdfUnite) plus an
   HTML document shell with branding and a sheet-spec → xlsx renderer (exceljs as
   optional peer) — vendored back. `create_document` + `create_spreadsheet` abilities
   (`file_write`, the category's first occupants). Company Settings → Documents
   (letterhead: company name, accent, footer). LibreOffice + poppler enter the deploy
   image. UI: Documents settings section; work-product file chips on the run desk.
   **SHIPPED** (see the sections above; `lib/documents.ts` holds the abilities and
   branding accessors).
3. **The workbench.** `runs.transcript` persisted at suspension and `runAgent`
   resumption via `priorMessages` (activated — first caller); the **generic approval
   executor** (`lib/approval-executor.ts`): claims decided approvals by
   `executed_at`, carries the approved action out with the run's own abilities,
   resumes suspended runs with an `approval_decision` turn, and spawns
   `approval_followup` runs for approvals whose run already ended (the call
   dead-end, fixed); declines also resume so the agent adapts and informs. The
   `reply_to_thread` special case is gone. `assignments` table + `take_assignment`
   ability; assignment runs execute on the dedicated `bunkhouse-deep-work` BullMQ
   queue (concurrency 2 — a long deliverable never stalls mail sync) with a
   60-step budget; delivery is verified against the mail ledger, never the model's
   word. UI: **Work subtab** on the agent drawer (status, recipient, files, run
   link); run desk shows a Work product card.
   **SHIPPED** (migration `0021_deep_work`).
4. **Ask on a call, receive by email.** Caller identity from auth (counterparty
   carries the signed-in operator's name/email; "Demo Owner" is gone);
   session+run+token created by `startCallAction` on an explicit **Place call** —
   page loads create nothing (the 10-minute sweep remains as backstop); the call
   prompt teaches assignment capture (confirm contents, format, recipient, deadline
   out loud, then `take_assignment`); the transcript shows "Taking on …" activity;
   assignment source anchors to the call session.
   **SHIPPED.**
5. **World-class polish.** Render→read-back QA loop (agent re-reads its own rendered
   output before sending); reusable document templates per tenant; delegation ability
   (`delegate_to_colleague` constructing the typed delegation trigger — assignments
   between agents); outbound `place_call` "your report is ready" callback
   (voice-design slice 3 synergy); STT/TTS minute pricing (existing voice gap);
   Drive/OneDrive/SMB filing connectors; pptx if demanded. (`notify` level now
   records its manager-feed event — shipped with slice 3.)

## The workspace — the agent's own desk (slice 6)

Design: each agent has a **persistent home directory** at
`$BUNKHOUSE_AGENT_HOMES/<tenantId>/<personId>` (deploy: the `agent-homes` volume
mounted into web, worker, and voice services at `/data/agent-homes`; dev:
`.agent-homes/`). It persists across runs and calls — files an agent saves are on its
desk next time, like a human's working folder; memory stays in the Logbook, finished
work is **published** into the files ledger. Execution is fail-closed sandboxing:

- `run_shell` (`shell` category, so the dial governs it) — `/bin/sh -lc` under
  **bubblewrap** (`@appkit/process-sandbox`): only the agent's home writable, masked
  `/data /home /root /var`, no capability inheritance, 120 s limit, output capped at
  64 KB. Every command is an append-only `shell_sessions` row (migration
  `0022_workspace`) — the replayable record doctrine #9 demands — and a tool event on
  the run, so the run desk and live call transcript show the work. The ability is
  simply absent on hosts without bubblewrap (macOS dev): fail-closed, never
  unsandboxed. `bubblewrap` joins the deploy image.
- `run_script` (ungoverned) — pure-computation JavaScript in the QuickJS kernel
  (`@appkit/sandbox`, 5 s, no I/O): agents calculate instead of estimating.
- `list_workspace_files` / `read_workspace_file` (ungoverned, read-only) and
  `publish_workspace_file` (`file_write`) — the desk-to-deliverable bridge.

**SHIPPED (first pass)**, including housekeeping: Settings → Workspace holds the
tenant retention policy (`workspace.policy`; default **keep everything** — nothing is
deleted until an operator turns retention on, minimum 7 days), and a daily worker
pass retires only workspace files untouched past the window — the files ledger,
mail attachments, and deliverables are never in scope. Still open for the next
slice: a workspace browser on the agent profile (see the desk from the HR record),
per-tenant disk quotas, and network egress policy for sandboxed processes
(currently the sandbox shares host networking — bubblewrap's design; an egress
proxy is the right shape).

## The colleague tiers (shipped 2026-07-28, second pass)

What separates an employee from a tool is closing loops with people. Five capability
tiers landed together:

1. **Ask, wait, follow up.** `ask_and_wait` emails a person a question and genuinely
   suspends the run (`waiting_reply` + stored transcript + `runs.waiting`); the reply
   resumes it — the mailbox pass routes a thread's answer to its waiting run via
   `consumed_message_ids` instead of starting a fresh one. Silence gets one polite
   nudge after the configured days, then the agent is woken to decide (escalate, try
   another channel, close out honestly). `delegate_to_colleague` hands an AI colleague
   a real assignment whose result returns by email for review. Approval requests now
   read as human sentences (`describeAction` wired). Migration `0023_ask_and_wait`.
2. **Perception.** `read_file` extracts text from ledgered files — .docx (LibreOffice),
   .pdf (unpdf, with a scanned-images note), .xlsx (exceljs incl. formula results),
   text/HTML — and email conversations now list attachment file ids so agents open
   what they were sent. `revise_document` makes exact find/replace edits inside a
   .docx (FODT engine; formatting survives; revisions are new files). The assignment
   prompt teaches the read-back QA loop: render, re-read, fix, then send.
3. **Channels.** `place_call` (`phone_call` dial) dials extensions or E.164 over the
   tenant trunk — session first, then the INVITE, the voice worker answers `out-*`
   rooms with the call's purpose as its briefing; `transfer_call` (live phone calls
   only) REFERs the caller to a human extension. `send_sms` (five providers via
   @appkit/sms, key sealed, Settings → Text messaging) appears only when configured.
   Migration `0025_outbound_calls`.
4. **Work quality.** Read-back QA in the assignment brief; `revise_document` for
   iteration; honest failure prompts throughout.
5. **Human texture.** Working hours per agent (Overview tab; outside the window,
   inbound email work waits for the next one — duties and ringing phones are
   unaffected; migration `0024_working_hours`). A weekly self-report email to the
   manager built from the ledgers (runs, deliverables, waits, spend — never
   model-invented numbers), at most one per week. Autonomy graduation: five straight
   approvals in a category still on 'approval' surface a "ready for more trust" badge
   on the dial.

Google Workspace and Microsoft 365 mailboxes now connect by sign-in rather than by
password, over the same IMAP/SMTP engine: `@appkit/mailbox` **0.3.0** adds
`MailboxConnection.accessToken` (XOAUTH2 on both endpoints), `lib/mail-oauth.ts`
owns the credential lifecycle (sealed state + PKCE, code exchange, per-operation
access tokens, Microsoft's rotating refresh token written back in its own committed
transaction), and `/api/mail-oauth/{start,callback}` carry the round-trip. The
company registers its own Google/Entra application once under Settings → Mailboxes.

Also in this pass:

- **Recorded browser computer-use.** Six `computer_use`-governed abilities
  (`browser_open/click/type/read/screenshot/close`) on puppeteer-core + system
  Chromium: one session per run, every step — including refusals and failures — an
  append-only `browser_steps` row with a JPEG frame in the files ledger; SSRF checks
  on every navigation hop; downloads denied; typed passwords withheld from the
  ledger; sessions closed at run teardown and by an idle reaper. The run desk
  replays the session step by step. Migration `0026_browser_use`.
- **Video meetings + screen share** (voice slice 4). `send_meeting_link` emails a
  48-hour guest link; `/meet/<token>` is a no-login tokenized room (camera, mic,
  screen share); the voice worker answers `meet-*` rooms briefed on the purpose.
  Screen vision is honest: realtime models that accept mid-session context updates
  get the latest still injected (≤1 per 20 s); every meaningfully-changed frame
  (≤1 per 5 s) is filed as evidence regardless; cascade agents say plainly they
  cannot see the screen live. Unopened invitations are swept once the link
  expires. Migration `0027_meetings`.
- **Image understanding in mail.** Up to four inbound image attachments ride the
  run's opening turn as real image content — the agent sees the receipt, not its
  filename.
- **OCR.** Scanned PDFs (no text layer) fall through to pdftoppm + tesseract
  (first 10 pages, honest notes); `read_file` on an image OCRs it. tesseract and
  chromium joined the deploy image.

Still open: per-tenant document templates; Drive/OneDrive/SMB filing connectors;
Slack/Teams bridge; a live-vision cascade path (needs per-model vision capability
detection); meeting recording via LiveKit Egress.

**Generality note.** Assignments are not a "research report" feature: `take_assignment`
accepts any committed work a colleague could take on (formats optional — many
assignments are answered in the delivery email itself, no file), and the same
governed toolset — research, documents, spreadsheets, workspace/shell, scripts,
memory, scheduling, email, every tenant MCP integration — is live on every channel:
browser calls, PBX phone calls, inbound email, duties, and background assignment
runs. New abilities added to `assembleAbilities` appear everywhere at once.

AppKit backfill: `@appkit/office` (authoring specs + renderers) and the
`@appkit/mailbox` attachments change are made in the appkit repo per AGENTS.md and
consumed here via vendored tarballs. `files`/assignments/runtime changes stay here.

Key refs: survey of this repo 2026-07-28 (runtime abilities, call tools, mailbox
store, storage/docs package audit); `docx` and `exceljs` npm (MIT, pure-JS OOXML);
`@appkit/pdf` template engine + `@appkit/forms-pdf` Chromium runtime;
nodemailer attachment support; AI SDK v6 `generateText` message continuation.
