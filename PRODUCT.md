# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user is the plugin's author — a solo developer running long DSH (DeepSeek Harness)
coding sessions, usually with one agent in one repository, who wants to see and steer what
the agent knows and what it is allowed to do. Secondary audience (not yet served): other DSH
users who install the plugin; the surface is designed to publishing standard but not yet
onboarded for strangers.

The situation: mid-task, the developer suspects the agent is carrying the wrong context —
too many tools, knowledge that has gone stale, or a gap it keeps hitting. They need to
answer three questions fast without leaving the conversation: *what is it allowed to do?*,
*what does it know?*, *where is it failing?*

## Product Purpose

An operate surface for a self-improving knowledge layer. It exposes two things DSH keeps
implicit — the agent's tool/skill surface and its accumulated knowledge — and makes the
first steerable.

Concretely: capability packs (assembling the model-facing tool set per task), a curated
Markdown knowledge base (L1) with a two-stage staged/commit pipeline, struggle-triggered
web acquisition, and an evidence ledger recording whether knowledge actually helped.

## Positioning

Most memory tools store and recall. This one asks a question the others skip: **did it
work?** Every page carries confirmation/suspicion evidence gathered from real sessions
(did a struggle follow the moment this was injected?). That is what makes quality a
measurable property rather than a matter of taste — and it is the precondition the project
set for ever auto-promoting knowledge.

## Operating Context

- Mounted as a footer action in the DSH main sidebar, opening a centered overlay with tabs.
- Runs inside the DSH web shell (Electron desktop carrier over `app://`; no standalone port).
- Reads one host endpoint, `GET /learn-wiki/api/state`, polled while open; writes via
  `POST /learn-wiki/api/capabilities` and `POST /learn-wiki/api/commit`.
- React arrives through the host's module loader; no bundler step, no build.
- Theme follows the host via `--dsw-alias-*` tokens.

## Capabilities and Constraints

- **Capabilities tab**: segmented into *Tools* and *Skills* so 71 tools and 11 skills are
  answered one question at a time instead of stacked in one column. Full tool catalog with
  per-tool token estimate grouped by name family, current deny list, and checkbox toggling
  that writes `wiki.config.json`. Toggling takes effect at the next tool assembly, not
  instantly — the interface says so rather than pretending, and the checkbox itself moves
  immediately (optimistic, rolled back with an explanation if the write fails).
- **Knowledge tab**: committed pages sorted by page id — *not* by evidence class — with
  filters (all / confirmed / unconfirmed / counter-evidence / quarantined), each carrying
  its count so an empty bucket is visible before you click it. Plus the staged queue and
  one-click commit gated by the same `commitReadiness` check the agent tool uses.
- **Supply tab**: struggle-signal distribution, gap-queue funnel, recent gaps. Subagent
  struggles are counted separately and shown as such: they are recorded honestly but produce
  no consequences, because a subagent getting stuck says more about the prompt it was given
  than about the project's knowledge.
- **Historical sessions** (`wiki_sessions`, and `wiki_harvest session=<id>`): the local session
  store holds every past conversation with its full tool-call record, and until now **no code
  path read it** — pre-step injection, struggle detection and harvest all only ever saw "now",
  so "how did I solve this last time" had nowhere to live. `action=brief` produces a handover:
  what recent sessions were about, which files they touched, and **which walls recurred across
  sessions**. Measured on this repo, the top recurring wall is `edit requires reading "<path>"
  first` at 8 sessions / 46 hits — a number that was visible nowhere before. It reports facts
  only and draws no conclusions: a written-down conclusion goes stale and then misleads, while
  the raw facts let the reader judge for themselves.
- **Harvest entry point** (`wiki_harvest`): distil **a conversation** into staged knowledge
  pages. This exists because both automatic triggers are signals about our
  own failure — a retrieval miss ("I don't know") and a struggle ("I'm stuck") — and neither
  can notice the third and most valuable case: *we just worked something out*. Measured
  consequence of that gap: in one session a design rule the user stated out loud was never
  captured, while the automatic loop's only output was a page about a **different project
  with a colliding name**. The harvest path reads only what was actually said (human
  messages and assistant prose — never our own injections, never reasoning drafts), stages
  its output, and deliberately has **no commit parameter**: automatic production does not
  get to wave itself through the human gate.
- **Skill inventory** (read-only, this round): every available skill with its catalog
  description length and estimated per-request cost. Hiding skills from the catalog is
  deliberately out of scope.
- **Page reading** (read-only, this round): open any page to read its body, sources,
  frontmatter and evidence. Editing stays in git / the editor.
- Constraint: no new runtime dependency; the client stays hand-written CJS.
- Constraint: the host half must keep working with no browser attached.

## Evidence on Hand

Real data from the author's own bank as of the latest reading, which the surface must
render honestly: **15 committed pages + 1 staged**, gap queue `{done: 1, skipped: 1}`,
struggle records `{edit-churn: 35, repeat-failure: 3, recurring-error: 3}`. Tool catalog:
**71 tools, 4 denied** (`workflow`, `ralph`, `hindsight_sync_status`,
`hindsight_diagnose`).

The evidence distribution is `{new: 15}` — **every single page is still unrecalled.**
So on the knowledge tab the confirmed / unconfirmed / counter-evidence / quarantined
filters are all empty and only *all* has content. That is the ledger being days old, not a
bug, and the filter counts are rendered precisely so this is visible without clicking.

Absences future work must not fabricate: no page has ever reached the `confirmed`,
`suspect` or `dead` class yet, no benchmark numbers, no testimonials.

## Product Principles

1. **Evidence over assertion.** Every quality claim in the UI is shown with its denominator.
   A page that has never been recalled is labelled as such rather than presented as knowledge.
2. **Reversible by default.** Demote, don't delete. Isolate from automatic injection, don't
   remove. The system cannot judge whether a piece of knowledge is *wrong*, only whether it
   has helped.
3. **The interface says what it did.** Silent no-ops are the project's recurring failure
   mode; a control that saved nothing, or a rule that matched nothing, must say so.
4. **Familiar affordances.** This is a tool the user is inside of, not a showcase. Earned
   familiarity beats invention; the interface should disappear into the task.
5. **Honest empty states.** Most panels are empty on a young ledger. Empty states teach what
   would fill them rather than apologising.
6. **Position never encodes state.** A row's place in a list is fixed by an identity that
   evidence cannot move (name family, page id). What needs attention is expressed by inline
   markers and filters, never by reordering. The poll runs every 8s; if ordering tracked
   evidence, the list would rearrange itself under the user's cursor between two clicks.
   This rule was learned twice — first on the tools table (denied rows were hoisted to the
   top, so clicking a checkbox made the row vanish from under the pointer), then again on
   the knowledge tab (sorted by attention rank, which is derived from evidence).

## Verification

The interface is checked without a browser in the loop and without a running DSH:

- `verify-render.mjs` renders the real component tree with real React and asserts structure
  (no crash, correct grouping, matching row counts and order). Primitive components are
  local stand-ins and each one is marked `data-stub` — **the test makes no claim about
  styling.** It caught a live bug on its first run: the family-group counter incremented
  the row object instead of the group, so every group header read "1".
- `ui-probe.mjs` measures the same page through real browser layout (headless Chrome over
  CDP) and reports geometry as text — column widths, row heights, scroll length, which
  cells are clipped. This is the path that works for a model that cannot read images.
- `ui-snapshot.mjs` writes HTML and PNG for humans or image-capable models.
- `verify-subagent-guard.mjs` drives the plugin with root, subagent and unknown-depth
  agents and asserts both directions: a subagent must produce **no** consequences (no
  suspicion on knowledge it was shown, no gap queued, no web search), while a root agent
  must keep producing them, and an agent whose depth cannot be read must be treated as a
  root agent — over-blocking would silently stop the knowledge base from ever learning.
  Writing this test surfaced a real bug: `appendGap` and the usage ledger were unguarded
  read-modify-write on a whole file, so two agents recording 3 ms apart **lost one entry
  outright** (`lib/lock.js` now serialises both).
- `verify-sessions.mjs` covers the historical-session layer, whose failure mode is unusually
  quiet: it reads data that has *already happened*, so a mis-digest misleads without anyone
  noticing at the time. Three judgements are pinned with measured justification: an outer
  `run_code` failure is a **restatement** of an inner dispatch and must not be counted twice
  (measured 124 inner vs 122 outer — near 1:1, so counting both would double every wall); the
  non-zero-exit heuristic applies only to **shell tools** (51 of 759 exit markers come from
  non-shell tools, mostly `job_output` echoing another process's stdout); and a failure with
  **no describable symptom** does not become a "wall" (otherwise the fingerprint is a pile of
  `PASS` lines) but is still counted in `weakFailures` rather than silently dropped. The test
  also caught a real bug: the symptom-detection regex included `exit`, which appears in *every*
  shell failure's fingerprint, making that filter a no-op.
- `verify-harvest.mjs` asserts that the harvest path never treats our own injected blocks,
  the skill catalog or subagent receipts as things the human said — doing so would fold our
  own output back into the knowledge base as if it were evidence — and that a page with the
  same **title** is reported as a duplicate even when its derived id differs (Chinese titles
  derive to `note-<hash>`, so id-only dedup silently lets a second copy in).

The honest limit: stand-ins mean control-level appearance is unverified. A stand-in icon
missing `width`/`height` rendered at the browser default 300×150 and stretched a 26px
column to 105px tall — a measurement of the stand-in, not of the product.
