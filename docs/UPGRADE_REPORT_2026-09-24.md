# Upgrade completion report — 2026-09-24

Covers the seven-functionality upgrade: an audit of the six existing modules, the fixes that audit
produced, and the new **AI Video Editor**.

Baseline at start (`8b98b81`): 268 tests, typecheck and lint clean.
State now (`2dcb6d5`): **594 tests, typecheck clean, lint clean, production build clean.**

---

## 1. What was done, by phase

| Phase | Outcome |
| --- | --- |
| 1 — Audit | 11 parallel subsystem readers; every claimed defect re-checked by an independent adversarial verifier. **72 verdicts, 71 confirmed.** [docs/AUDIT_2026-09-24.md](AUDIT_2026-09-24.md) |
| 2 — Core fixes | Queue foundation rebuilt (lanes, leases, timeouts, dead-lettering) |
| 3 — Meta | Webhook signatures, dedupe, token expiry, permission revocation |
| 4 — CRM | Attribution, flow integrity, pagination, tags/follow-up/value fields |
| 5 — AI agents | Cost table, retry semantics, background processing, prompt-injection framing |
| 6–7 — Video editor | Storage layer, FFmpeg pipeline, audio mixing, subtitles, sample analysis, chat assistant |
| 8 — Publishing bridge | Export hands a real, reachable URL to the existing publish pipeline |
| 9 — QA & security | 5 adversarial review dimensions, every finding verified. **27 confirmed defects, all remediated** (see §4) |
| 10 — Report | This document, plus [MANUAL_SETUP_GUIDE.md](../MANUAL_SETUP_GUIDE.md) |

**118 defects fixed**: 60 in the seven repair tracks, 26 more found by the review pass over them,
3 I found directly, 27 found by the phase-9 QA review — including a critical one that would have made
the video editor refuse every render in production — and 2 gaps the remediation deliberately left
open, which I then closed myself (see below).

---

## 2. Features completed

### Functionality 1 — Comment & DM automation
Keyword triggers, AI replies with a real guard chain, fallbacks, per-user cooldown and account rate
limits, human handoff, knowledge-base retrieval, multilingual operation.

**Fixed here:** comment automations double-fired on Meta's at-least-once redelivery (a commenter got
two private replies); a resource-plus-caption send attempted two private replies where Meta allows
one, so the caption always failed; an admin's manual send claimed human takeover without pausing the
AI; conversation detail returned the *oldest* 200 messages, hiding the newest; attachment-only DMs
made the agent re-answer the previous message; retrieved knowledge chunks now carry an explicit
untrusted-data envelope against prompt injection.

### Functionality 2 — Lead management + CRM
Source attribution, pipeline, assignment, activity history, duplicate detection.

**Fixed here:** lead-ad answers were silently dropped from Telegram and email notifications
(the stored shape differed from what the builders accepted); deleting a flow bricked the Lead Button
builder permanently; `PATCH /api/cta/[id]` accepted another account's flow id; editing a flow's
questions destroyed the answer history of completed sessions; the list silently truncated at 500.
**Added:** tags, follow-up dates, deal value, won/lost reason, real pagination.

### Functionality 3 — Boost Reels through Meta Ads
Full Marketing API chain, created **PAUSED**, typed-name confirmation to activate, real reach
estimates with honest `-1` handling, live spend sync.

**Fixed here:** locally archiving a campaign that was ACTIVE in Meta abandoned a still-spending
campaign; a mid-chain failure left orphaned Meta objects on retry; pausing a local draft bricked it.
**Added:** Meta's own review verdict (`effective_status`, `issues_info`) persisted on sync — never
inferred locally.

### Functionality 4 — Targeting + ad payment
**Fixed here (high):** a percent-based campaign fee was computed across mismatched currencies with no
conversion. It is now refused with an explanation rather than guessed. Off-session charges are
idempotent; cancelling one scheduled payment no longer halts the recurring schedule; partial refunds
are recorded as partial.

The separation the platform already had is preserved and reinforced: **Meta bills the ad account's
own payment method. This platform cannot and does not pay Meta.** Platform service fees go through
Stripe's hosted Checkout; no card data reaches this database.

### Functionality 5 — Instagram Lead Button
Three honest delivery paths: a hosted landing page, DM/comment keyword, and a real native CTA under a
promoted Reel.

**Fixed here:** an admin-supplied validation regex ran against public input unanchored and untimed
(ReDoS); the honeypot returned an explicit 400 that told a bot exactly what happened.

**Known gap, deliberately not faked:** the comment-keyword path is advertised in three UI strings but
the bridge from a comment keyword into the question flow is still missing. It is listed in §5 rather
than quietly implemented as something it is not.

### Functionality 6 — Content upload & Instagram management
**Fixed here (high):** a token failure before the main handler left a scheduled post stuck in
`SCHEDULED` forever with no error; the early-wake re-enqueue collided with its own idempotency key so
an early-woken post never published; a cancel issued while a worker pass was in flight published
anyway and overwrote the status; non-Latin filenames returned 500 from the public file route, which
broke both the human link and Meta's attachment fetch; Story insights requested the FEED metric set
and always failed while the UI reported success.

### Functionality 7 — AI Video Editor (new)

| Capability | State |
| --- | --- |
| Upload (drag-drop, progress, validation, cancel) | Complete |
| Trim, speed, aspect, crop/pad, colour | Complete |
| Independent original + uploaded audio volumes | Complete |
| Track delay, trim, fade in/out, loop, ducking | Complete |
| Subtitles: auto-generate, manual, import, export | Complete |
| 7 subtitle presets + full styling | Complete |
| Per-word highlighting | Complete, gated on real word timings |
| Sample-video style analysis + feasibility plan | Complete |
| AI chat assistant (uz/ru/en) | Complete |
| Preview and export renders | Complete |
| Export → Instagram publishing | Complete |
| Undo history | Complete |

---

## 3. Tests performed

| Suite | Result |
| --- | --- |
| Full unit/integration suite | **594 pass**, 0 fail (was 268) |
| New video suites | 167 tests across params, render, subtitles, storage, job lifecycle, UI wording |
| `tsc --noEmit` | Clean |
| `eslint` | Clean, 0 warnings |
| Production build | Clean; 14 video routes + 2 pages emitted |

**Real FFmpeg verification** (not mocked — actual encodes, probed afterwards):

- Audio mix at original 30% / music 100%, verified in the output stream
- Mute-and-replace original audio
- Ducking (`sidechaincompress` present and encoding)
- Burned-in subtitles containing Uzbek (`oʻ`, `gʻ`), Russian Cyrillic and English
- **Injection-shaped caption text** — quotes, semicolons, braces, backslashes, Windows paths and
  filtergraph fragments — rendered as literal text with no command execution
- 2× speed with pitch-corrected audio; trim; thumbnail; 16 kHz mono extraction for transcription
- Scene-cut detection, loudness and framing measured from real pixels

**Live-server verification** (dev server running):

| Route | Result |
| --- | --- |
| `/v/<invalid token>` | 404 JSON — publicly reachable, token correctly rejected |
| `/video-editor` | 307 to `/login?next=/video-editor` — protected |
| `/api/video/projects` | 401 JSON, not a redirect |

**External service probes** (real calls):

- AI gateway `/models` → 200, 625 models
- AI gateway `/audio/transcriptions` → **402, no balance**
- Google AI `/models` → 200, Gemini 2.5/3 reachable
- FFmpeg 8.0.1 and ffprobe present

**Independent QA (phase 9):** 5 adversarial dimensions — video security, video correctness, the
applied fixes, UI honesty and i18n, integration and deployment. Every finding was verified by a
second agent that tried to refute it.

**27 defects confirmed, 1 refuted.** They are listed in §4 and were all remediated. An earlier draft
of this report said "zero confirmed defects"; that was wrong — it was written from partial workflow
output while several reviewers were still running, and is corrected here.

What the reviewers *did* clear, with line-level evidence: argv-only FFmpeg invocation with no reachable
injection path, path-traversal guards on storage keys, tenant isolation across all 12 video handlers
including child-id lookups, the `/v/` role gate, absence of SSRF, migration correctness with no schema
drift, handler registration in every draining process, and the export-bridge shape matching what the
publish route accepts.

**i18n:** 1248 keys in each of en/uz/ru, zero divergence, 154 video-editor keys per language.

**Migrations:** verified against an offline schema diff — no drift. The only difference from Prisma's
own output is statement splitting.

---

## 4. Defects the QA pass found, and what happened to them

The review was worth running: it found a **critical** flaw that would have made the video editor
refuse every render on the exact deployment this platform documents.

| Severity | Defect | Resolution |
| --- | --- | --- |
| Critical | The render gate asked whether the **web** process had FFmpeg. On Vercel it never does, so every render was refused while a healthy worker sat idle | Gated on the worker heartbeat instead; the local binary is now only context for the single-host case |
| High | The worker stopped heart-beating *while* draining, so a worker busy with a long render reported itself offline and new renders were refused | Heartbeat renews during the drain |
| High | Burned-in subtitles ignored trim and speed, so every trimmed or sped-up export had captions at the wrong moment | `retimeCues()` maps cues onto the rendered timeline; 8 tests |
| High | Subtitle presets were inert — each one relabelled the style and rendered identically | Selecting a preset expands its full style; 5 tests |
| High | The currency-mismatch guard threw during the Campaigns list render, taking the whole Target page down | Remediated |
| High | The per-job timeout abandoned the await without stopping the handler, which could double-publish a post | Remediated |
| High | The byte-upload route buffered the whole body and its size check was bypassable with chunked encoding | Remediated |
| High | Unsaved subtitle edits were wiped by the background poll | Remediated |
| High | A source video that failed validation left the project unrecoverable, saying "try again in a moment" forever | Remediated |
| Medium ×13 | Job-lifecycle races, zombie queued jobs, stale preview presented as current, success toasts for queued work, sample selection re-checking itself, untranslated slugs, Blob content-type mismatch, unbounded subtitle words, local storage reported usable on serverless, and others | Remediated |
| Low ×4 | Suffix Range handling, missing audit records on subtitle edits, clock-skew in the early-wake re-enqueue, capability panel wording | Remediated |

Four items the remediation tracks honestly declined, and what happened to them:

- **Streaming writes to storage.** The upload route could bound how much it read but still had to
  assemble the accepted bytes, because the driver interface only took a `Buffer`. Both drivers now
  have a `putStream` that writes as bytes arrive and deletes its partial object on overflow, so the
  web tier's memory per upload is one chunk rather than one file. The local driver writes to a
  `.part` file and renames, so a reader can never see a half-written object.
- **No way to replace a failed source video.** The UI could only describe the dead end, because no
  API could detach the asset. `DELETE /api/video/assets` now removes a source that failed its checks
  (and only one that failed), and the editor offers it.
- **The upload reserve step did not refuse when storage was unusable.** It now returns 503 with the
  real reason instead of handing back an upload URL that could never hold a file.
- **Colour-look labels.** The dictionary entries existed; the buttons still showed raw slugs. Wired.

**Tests that failed:** none outstanding. During development one self-written pipeline check failed on
its own assumption (a synthetic clip had 2 scene cuts where the assertion expected the ≥3 needed to
emit a pacing item); the product logic was correct and the check was replaced by proper repo tests.

---

## 5. Blocked by external dependencies, or deliberately not done

| Item | Why | What unblocks it |
| --- | --- | --- |
| **Migrations not applied anywhere** | No database was reachable in this environment — the embedded Postgres refuses to run elevated, and Docker is absent | `npm run db:migrate` against your database |
| **No video render has run in production** | Requires a resident worker with FFmpeg, which does not exist yet | MANUAL_SETUP_GUIDE §10 |
| **Automatic subtitles via the gateway** | Its transcription endpoint returns 402 (no balance) | Top up, or set `STT_PROVIDER=google` — your Google key is valid |
| **All AI features in production** | The Vercel project has no AI key | Add `AI_API_KEY` (§8a) |
| **Video uploads in production** | No Blob store | Create one (§9) |
| **Email and Stripe** | Unconfigured everywhere | §8b, §12 |
| **Comment-keyword → lead flow** | Genuinely not implemented; advertised in 3 UI strings | Not built rather than faked; needs a decision on the private-reply flow |
| **Persisted "reconnect Facebook" flag** | Would need a schema column the fix track could not add | Now derived live from the token's real expiry instead, which cannot go stale |
| **Distributed rate limiting** | The limiter is still per-process on serverless | Login brute-force is now durable via audit-log counting; the general limiter needs Redis or a counter table |

---

## 6. Known limitations (stated, not hidden)

- **A serverless deployment cannot render video.** Vercel functions stop at 60s. The video lane exists
  precisely so a render is never claimed by a process that would be killed; the UI reports the worker
  as offline rather than showing a progress bar against nothing.
- **Style replication is partial by design.** Motion graphics, tracked overlays, beat-synced cutting
  and face-aware reframing are marked `unsupported` and refused, not approximated badly.
- **Per-word subtitle highlighting needs a provider that returns word timings.** Gemini does not;
  the control disables itself and says so.
- **Volume percentages are signal levels, not perceived loudness.** Stated in the UI.
- **Meta cannot be paid from this platform.** Ad spend is billed by Meta to the ad account.
- **A render served from localhost cannot be published.** Instagram fetches the file over the
  internet; the export screen blocks with that reason rather than failing opaquely at Meta.

---

## 7. Deployment requirements

1. Apply both migrations: `npm run db:migrate`.
2. Add the missing production environment variables (§12 of the setup guide).
3. Stand up a worker host with FFmpeg and `fonts-dejavu-core` for video (§10).
4. Provision video storage (§9).
5. Enable `instagram_business_content_publish` on the Meta app if video publishing is wanted (§2).
6. Ensure both `META_APP_SECRET` and `META_INSTAGRAM_APP_SECRET` are set — webhook signatures are
   checked against either, and the Instagram product signs with the latter.

---

## 8. Recommended next steps

1. **Rotate the GitHub and Vercel tokens** shared during this work. Neither was written into the repo.
2. Apply the migrations and add the production AI key — the largest single gap between what the code
   does and what your deployment can do.
3. Stand up the video worker, then run one real end-to-end render and publish.
4. Decide on the comment-keyword lead path: build the private-reply bridge, or remove the three UI
   strings that promise it.
5. Replace the in-memory rate limiter with a shared store if the deployment stays serverless.
6. Add CI: the repository has a worker heartbeat workflow but nothing runs typecheck, lint or tests on
   push, despite the development plan claiming otherwise.
