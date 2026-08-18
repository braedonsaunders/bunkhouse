# Skills

A skill is portable competence: reusable know-how — how to build a well-formed spreadsheet,
how to lay out a proposal — written in the public [`SKILL.md`
format](https://agentskills.io/specification) and installed from a repository rather than
authored in the app.

They live under **Resources → Skills**, alongside the other things an agent brings to the job.

## Skills are not procedures

This distinction is load-bearing; collapsing it would break product doctrine #3.

| | Procedure | Skill |
|---|---|---|
| Authority | Binding doctrine — follow it or say why | Available — used when the work calls for it |
| Origin | Authored here, by the company | Installed from a repository, pinned to a commit |
| Context cost | Full body in every prompt for assigned agents | Name and description only; body on demand |
| Audit | Version-pinned per run, cited by slug | `skill_loaded` run event |
| Governs | What the agent must do | Nothing — a skill grants no authority |

A skill can never loosen a procedure. The skill index is rendered *after* procedures in the
system prompt, and the ground rules that bind an agent are unchanged by loading one.

## Progressive disclosure

Only each skill's name and description reach the system prompt — roughly a hundred tokens
apiece, paid on every run whether or not any skill is used. That is what makes a shelf of
thirty affordable.

When the agent judges a skill relevant it calls `load_skill`, which returns the full
markdown. The ability is ungoverned (`category: null`) because reading instructions changes
nothing outside the run. Everything the instructions then tell the agent to do runs through
the ability that actually does it — sending mail, writing a file, running a command — each
governed by its own dial exactly as it would be if the agent had thought of it unaided.

Implementation: [`packages/runtime/src/skills.ts`](../packages/runtime/src/skills.ts), folded
into the prompt by `buildSystemPrompt` and into the toolbox by `runAgent`.

## Installing, and the pin

Two GitHub API calls do the whole job: one resolves the branch or tag to the commit it points
at right now, one lists that commit's tree. The file bytes come from
`raw.githubusercontent.com`, which is not subject to the API's hourly limit — so a thirty-file
skill costs two API calls, not thirty.

**The commit is the pin, and nothing is ever fetched during a run.** An install copies the
bytes into the tenant; the runtime reads only what is stored. An agent's behaviour is
therefore a function of what the company chose to install, not of what a repository looked
like at the moment it ran — which is the only way a run from last week stays explicable.

Upstream moving shows up as an offered update, never applied silently. Updating writes the
next version; the previous one stays on the record, exactly like a procedure revision.

Set `BUNKHOUSE_GITHUB_TOKEN` on the deployment to raise the unauthenticated API limit. It is
deployment infrastructure, not tenant configuration — no tenant's skills depend on it.

### What is refused at install

- Front matter that does not conform: missing or malformed `name` (lowercase, hyphenated, ≤64
  chars, matching its folder, not reserved), missing `description`, or one over 1024 chars.
- Symlinks and submodules, which can point outside the bundle.
- Paths that are absolute, contain `..`, or carry a backslash or drive letter.
- Bundles over 200 files, 2 MB per file, or 8 MB in total.

Unrecognised front-matter keys are **preserved**, not dropped — a skill written for another
agent product reads back here as its author wrote it.

## Scripts

Public skills routinely ship Python or shell alongside their markdown. Those scripts run
through the sandboxed shell an agent already has — there is no second execution path and no
new autonomy category.

When `load_skill` runs, the bundle is written into a run-scoped folder under
`~/.bunkhouse/runs/<run>/skills/<name>/` on the agent's persistent microVM, and the tool
returns that folder. The agent then runs, say, `python3 <returned-folder>/scripts/fill_form.py`
via `run_shell` ([`lib/workspace.ts`](../apps/web/src/lib/workspace.ts)). It is the same
machine, filesystem, shell policy, and append-only Desk ledger used by the graphical desktop
and browser—there is no web-container staging home or parallel shell sandbox.

Everything follows from that, for free:

- the company's shell feature off → scripts cannot run at all;
- the agent's sandbox dial governs access to the machine;
- every execution and skill materialization produces replayable Desk events in Activity.

The bundle is rewritten from the database on every load, so a file an agent altered on a
previous run never becomes what the skill "is". The workspace copy is a cache; the installed
bytes are the truth.

## Storage

Mirrors the procedures shape, so "applies to" means one thing across the app.

- `skills` — slug, title, description, status, current version, `assignment` (everyone / roles
  / named agents), `source` (repo, ref, **commit SHA**, path), licence, `has_scripts`.
- `skill_revisions` — append-only. Body, front matter, and the commit each version came from.
- `skill_files` — the bundle manifest; bytes in object storage, like the file ledger.

All three are tenant-scoped and RLS-enforced (`SKILLS_TENANT_TABLES`), migration `0036_skills.sql`.

## Licensing

The catalogue shows each entry's declared licence *before* installing, because several
widely-used skills — Anthropic's `docx`, `xlsx`, `pptx`, and `pdf` among them — are
source-available rather than open source. That is a decision a company should make knowingly
rather than discover afterwards. Installing copies a third party's work into the tenant; it
does not vendor anything into this repository, so the AGPL/MIT split here is untouched.
