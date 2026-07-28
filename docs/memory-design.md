# The Logbook — bunkhouse memory architecture (design, researched 2026-07-28)

Verdict from the July-2026 field survey (Letta/MemGPT, Zep/Graphiti, mem0, LangMem,
A-MEM, Generative Agents, Anthropic "Dreaming"): human-readable notes are the WINNING
substrate, not the naive baseline — Letta showed plain files + grep beating mem0's
extraction pipeline on its own benchmark. Bunkhouse's flat notes fail four ways:
loaded wholesale, silently stale, unlinked, never improving. The Logbook fixes those
while staying markdown-in-Postgres, RLS-scoped, append-only, human-editable.

## Core decisions
1. **Four note kinds** (LangMem taxonomy): fact / episode / procedure / reflection —
   different half-lives, retrieval weights, consolidation rules.
2. **[[Wikilinks]] are the graph** (A-MEM, done readably): parsed on write into a
   memory_links cache; backlinks in the UI; retrieval does one hop of link expansion
   in SQL. Reflections MUST cite evidence links.
3. **Bi-temporal supersession** (Zep's idea as Postgres rows): notes never edited into
   falsehood, never deleted — new note + valid_until/superseded_by on the old + revision
   snapshot. "What did this hand believe on July 1" is a WHERE clause.
4. **Two context tiers** (Letta): pinned notes under a hard token budget always in
   prompt; everything else via scored retrieval + a search_memory tool. Kills
   wholesale loading.
5. **Retrieval score** (Generative Agents): 0.30 FTS rank + 0.15 embedding sim
   (phase 2) + 0.25 importance/5 + 0.20 recency decay (per-kind half-life) +
   0.10 use_count. tsvector primary; pgvector strictly a rebuildable cache column.
6. **Consolidation jobs** (sleep-time compute / Dreaming), all outputs readable:
   nightly per-hand journal (episodes + fact candidates from run events), weekly
   reflection (salience-triggered, evidence-cited, procedure changes are PROPOSALS),
   monthly company gardener (merge/expire/contradiction proposals rendered as diffs;
   auto-apply only provably-safe class).
7. **Promotion hand→company is approval-gated** (memory_proposals) — hands nominate,
   humans decide; the prompt-injection→consolidation poisoning path Anthropic warns
   about is closed by the same approval UX the rest of the product uses.
8. **Usage telemetry from run events**: memory.retrieved events roll into
   last_used_at/use_count — notes earn their keep.

## Schema (to become migrations when built)
memory_notes(id, tenant_id, scope hand|company, hand_id, slug, kind, title, body_md,
  pinned, importance 1-5, valid_from, valid_until, superseded_by, source_run_id,
  author hand|human|consolidator, last_used_at, use_count, tsv GENERATED, embedding NULLABLE)
memory_note_revisions(note_id, rev, title, body_md, edited_by, reason)  -- append-only
memory_links(from_note, to_note)                                        -- parse cache
memory_proposals(kind promote|merge|supersede|expire|edit, note_id, payload diff,
  rationale, proposed_by, status open|approved|rejected|auto_applied, decided_by)

## Build order
1. Schema + revisions + wikilink parse/backlinks UI + supersession (no LLM, biggest safety win)
2. Scored tsvector retrieval + search_memory runtime tool + retrieval events
3. Nightly journal + weekly reflection worker jobs
4. Proposals UI + promotion + monthly gardener
5. pgvector as additive signal only if FTS recall measurably falls short

Full research report with sources lives in the session log; key refs: Zep arXiv
2501.13956, A-MEM arXiv 2502.12110, Letta sleep-time compute arXiv 2504.13171,
Generative Agents (Park 2023), Letta memory benchmark post, OSS Insight agent-memory
race 2026.
