#!/usr/bin/env node
// @ts-check
/*
 * autoscribe-run.mjs — single-PR sync runner for the Autoscribe GitHub Action.
 * ---------------------------------------------------------------------------
 * This is the per-PR step of `autoscribe-sync`. It adapts the reference
 * pipeline's `scripts/librarian/server.mjs` orchestrator (which polled a queue
 * and shelled out to a local LLM CLI) down to a single unit of work that fits
 * cleanly inside one GitHub Actions invocation:
 *
 *   1. Load committed config (.autoscribe/config.json) + runtime state
 *      (.autoscribe/state.json) — the GitHub-native "database". No DB, no
 *      Firebase; git history is the audit log.
 *   2. Resolve the target PR from the client_payload (repository_dispatch) or
 *      CLI args / env (the scheduled-poll fallback).
 *   3. Enforce the cheap guardrails up front: spend ceiling + wave/queue cap.
 *   4. Fetch the watched-repo PR diff (via `gh` if available, else the REST API
 *      with fetch()).
 *   5. Invoke the Claude Code CLI headlessly with prompts/analyze.md, feeding it
 *      the PR JSON on stdin. The agent classifies the doc gap and (if any) edits
 *      markdown under config.docsDir + sidebars.ts in the working tree.
 *   6. Update state.json: advance the cursor, set the queue entry's terminal
 *      status, append a runLog entry. Committing/PR-opening is done by the
 *      surrounding workflow (git + gh) — this script only owns state + the agent.
 *
 * Design constraints:
 *   - Dependency-light: Node built-ins (fs, path, child_process, crypto) only.
 *   - Well-commented: this doubles as the reference implementation for the spec.
 *   - Fail soft: a single bad PR records an error in the runLog and exits
 *     non-zero, but never corrupts state.json (atomic write).
 *
 * Status lifecycle (mirrors state.schema.json):
 *   queued -> in_progress -> no_gap | drafted | published
 *
 * Usage:
 *   node scripts/autoscribe-run.mjs --pr 129 [--repo owner/name]
 *   AUTOSCRIBE_PR=129 node scripts/autoscribe-run.mjs
 *   # repository_dispatch: the workflow passes
 *   #   github.event.client_payload (JSON) via AUTOSCRIBE_PAYLOAD
 *
 * Env knobs:
 *   AUTOSCRIBE_PAYLOAD   JSON client_payload, e.g. {"pr":129,"repo":"owner/name"}
 *   AUTOSCRIBE_PR        PR number (overrides payload)
 *   AUTOSCRIBE_REPO      watched repo owner/name (overrides config.watchedRepo)
 *   GITHUB_TOKEN / GH_TOKEN  token for diff fetch (gh uses it automatically)
 *   ANTHROPIC_API_KEY    the user's key; consumed by the Claude Code CLI
 *   CLAUDE_BIN           path to the Claude Code CLI (default: "claude")
 *   AUTOSCRIBE_DRY_RUN   "1" to skip the agent call (plumbing test)
 *   AUTOSCRIBE_HOME      repo root (default: process.cwd())
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// --------------------------------------------------------------------------
// Paths & small helpers
// --------------------------------------------------------------------------

const HOME = resolve(process.env.AUTOSCRIBE_HOME || process.cwd());
const CONFIG_PATH = join(HOME, ".autoscribe", "config.json");
const STATE_PATH = join(HOME, ".autoscribe", "state.json");
const ANALYZE_PROMPT_PATH = join(HOME, ".autoscribe", "prompts", "analyze.md");

/** Structured log line so Action logs are greppable. */
function log(level, msg, extra) {
  const line = `[autoscribe:${level}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

/** Read + parse JSON, throwing a clear error on malformed files. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read/parse JSON at ${path}: ${err.message}`);
  }
}

/**
 * Atomic JSON write: write to a temp file, then rename over the target. A
 * crashed run can never leave a half-written state.json (rename is atomic on
 * the same filesystem).
 */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newRunId() {
  return `${nowIso().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

// --------------------------------------------------------------------------
// Input resolution: client_payload (dispatch) OR args/env (poll)
// --------------------------------------------------------------------------

/** Parse `--pr 129 --repo owner/name` style flags. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") out.pr = Number(argv[++i]);
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

/**
 * Resolve the target {repo, pr} from, in priority order:
 *   1. CLI flags (--pr/--repo)
 *   2. AUTOSCRIBE_PR / AUTOSCRIBE_REPO env
 *   3. AUTOSCRIBE_PAYLOAD JSON (repository_dispatch client_payload)
 *   4. config.watchedRepo (for repo only)
 */
function resolveTarget(config, args) {
  let payload = {};
  if (process.env.AUTOSCRIBE_PAYLOAD) {
    try {
      payload = JSON.parse(process.env.AUTOSCRIBE_PAYLOAD);
    } catch (err) {
      log("warn", `Ignoring unparseable AUTOSCRIBE_PAYLOAD: ${err.message}`);
    }
  }

  const prRaw =
    args.pr ?? process.env.AUTOSCRIBE_PR ?? payload.pr ?? payload.prNumber;
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(
      `No valid PR number resolved (got ${JSON.stringify(prRaw)}). ` +
        `Pass --pr, set AUTOSCRIBE_PR, or include "pr" in AUTOSCRIBE_PAYLOAD.`
    );
  }

  const repo =
    args.repo ||
    process.env.AUTOSCRIBE_REPO ||
    payload.repo ||
    config.watchedRepo;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(
      `No valid watched repo resolved (got ${JSON.stringify(repo)}). ` +
        `Set config.watchedRepo or pass --repo owner/name.`
    );
  }

  return { repo, pr, payload };
}

// --------------------------------------------------------------------------
// Guardrails (cost & safety — it's the USER'S Anthropic key)
// --------------------------------------------------------------------------

/**
 * Sum spend recorded so far TODAY from the runLog. Used to enforce the soft
 * spend ceiling before we spend more of the user's money. Conservative: if any
 * run lacks a spendUSD figure it simply doesn't contribute.
 */
function spendToday(state) {
  const today = nowIso().slice(0, 10); // YYYY-MM-DD
  return (state.runLog || [])
    .filter((r) => typeof r.at === "string" && r.at.slice(0, 10) === today)
    .reduce((sum, r) => sum + (Number(r.spendUSD) || 0), 0);
}

/**
 * Pre-flight guardrail checks. Returns { ok, reason }. Cheap checks only —
 * the real spend protection is BYO-key + the ceiling + the analyze.md NO_GAP
 * fast path keeping the common case to ~one cheap call.
 */
function checkGuardrails(config, state) {
  // 1. Spend ceiling: if today's recorded spend already meets/exceeds the
  //    ceiling, stop before incurring more.
  const ceiling = Number(config.spendCeilingUSD);
  if (Number.isFinite(ceiling) && ceiling > 0) {
    const spent = spendToday(state);
    if (spent >= ceiling) {
      return {
        ok: false,
        reason: "spend_ceiling",
        detail: `today's spend $${spent.toFixed(2)} >= ceiling $${ceiling.toFixed(2)}`,
      };
    }
  }

  // 2. Wave/queue cap: never let the in-flight queue exceed waveSize. This
  //    runner does ONE PR, but the cap protects against a flood of dispatches
  //    piling up `in_progress`/`queued` work faster than humans can review.
  const waveSize = Number(config.waveSize) || 8;
  const active = (state.queue || []).filter(
    (q) => q.status === "queued" || q.status === "in_progress"
  ).length;
  if (active >= waveSize) {
    return {
      ok: false,
      reason: "wave_cap",
      detail: `active queue ${active} >= waveSize ${waveSize}`,
    };
  }

  return { ok: true };
}

// --------------------------------------------------------------------------
// PR diff fetch — gh CLI preferred, fetch() fallback
// --------------------------------------------------------------------------

/** True if a binary is on PATH and runs. */
function hasBin(bin) {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Fetch the unified diff and metadata for a watched-repo PR.
 * Returns { title, diff, files }.
 */
async function fetchPr(repo, pr) {
  const [owner, name] = repo.split("/");

  // Preferred path: gh CLI (already authenticated in Actions via GITHUB_TOKEN).
  if (hasBin("gh")) {
    const meta = spawnSync(
      "gh",
      ["pr", "view", String(pr), "--repo", repo, "--json", "title,files"],
      { encoding: "utf8" }
    );
    const diff = spawnSync("gh", ["pr", "diff", String(pr), "--repo", repo], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024, // big diffs
    });
    if (meta.status === 0 && diff.status === 0) {
      const parsed = JSON.parse(meta.stdout || "{}");
      return {
        title: parsed.title || "",
        diff: diff.stdout || "",
        files: (parsed.files || []).map((f) => f.path),
      };
    }
    log("warn", `gh fetch failed (status ${meta.status}/${diff.status}); falling back to REST`);
  }

  // Fallback path: REST API via fetch(). Diff comes from the `.diff` media type.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const base = `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`;
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  const metaRes = await fetch(base, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "autoscribe", ...authHeaders },
  });
  if (!metaRes.ok) throw new Error(`PR metadata fetch failed: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();

  const diffRes = await fetch(base, {
    headers: { Accept: "application/vnd.github.v3.diff", "User-Agent": "autoscribe", ...authHeaders },
  });
  if (!diffRes.ok) throw new Error(`PR diff fetch failed: ${diffRes.status} ${diffRes.statusText}`);
  const diff = await diffRes.text();

  // File list is a separate endpoint (paginated; first page is enough for routing).
  let files = [];
  try {
    const filesRes = await fetch(`${base}/files?per_page=100`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "autoscribe", ...authHeaders },
    });
    if (filesRes.ok) files = (await filesRes.json()).map((f) => f.filename);
  } catch {
    /* non-fatal — the diff already lists the files */
  }

  return { title: meta.title || "", diff, files };
}

// --------------------------------------------------------------------------
// The agent call — Claude Code CLI with prompts/analyze.md
// --------------------------------------------------------------------------

/**
 * Invoke the Claude Code CLI headlessly, feeding analyze.md as the system
 * prompt and the PR JSON on stdin. The agent classifies the gap and, when it
 * finds one, edits markdown under config.docsDir (and sidebars.ts) directly in
 * the working tree. The surrounding workflow commits + opens/updates the Draft
 * PR afterwards.
 *
 * The prompt (.autoscribe/prompts/analyze.md) owns the canonical output
 * contract: a final JSON object `{ "type":"sync", "result":<GAP_TYPE|NO_GAP>,
 * "target_files":[...], "severity":..., "reason":... }`. runAgent() passes that
 * through normalizeResult(), which derives the booleans/counts the state machine
 * uses: { gapType, hasGap, docsChanged, summary, severity, spendUSD?, raw }.
 *
 * The Claude Code CLI flags below match its headless mode:
 *   -p / --print            non-interactive, print result and exit
 *   --append-system-prompt  prepend analyze.md to the system prompt
 *   --model                 per-PR model from config.model
 *   --output-format json    machine-readable result envelope
 * The model is told (via analyze.md) to end with a single JSON object; we parse
 * the last JSON object out of its final message.
 */
function runAgent({ config, prInput }) {
  if (process.env.AUTOSCRIBE_DRY_RUN === "1") {
    log("info", "DRY_RUN=1 — skipping agent; treating PR as NO_GAP");
    return normalizeResult({ result: "NO_GAP", reason: "dry run", target_files: [] });
  }

  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const systemPrompt = existsSync(ANALYZE_PROMPT_PATH)
    ? readFileSync(ANALYZE_PROMPT_PATH, "utf8")
    : "";
  if (!systemPrompt) {
    log("warn", `analyze prompt not found at ${ANALYZE_PROMPT_PATH}; running with bare instruction`);
  }

  // The user prompt is the PR context as JSON, exactly as analyze.md expects on
  // stdin. We pass it as the -p argument's content via stdin to avoid arg-size
  // limits on large diffs.
  const userPrompt =
    "Analyze this pull request for documentation gaps and apply any edits to " +
    `markdown under "${config.docsDir}/" and sidebars.ts. Input:\n` +
    JSON.stringify(prInput);

  const args = [
    "-p",
    "--model",
    String(config.model || "sonnet"),
    "--output-format",
    "json",
  ];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  log("info", `invoking ${claudeBin} (model=${config.model}) for ${prInput.repo}#${prInput.pr}`);
  const res = spawnSync(claudeBin, args, {
    input: userPrompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env, // carries ANTHROPIC_API_KEY through
  });

  if (res.status !== 0) {
    throw new Error(
      `Claude Code CLI exited ${res.status}: ${(res.stderr || "").slice(0, 2000)}`
    );
  }

  return parseAgentOutput(res.stdout || "");
}

/**
 * Pull the analyze result out of the CLI output. With --output-format json the
 * Claude Code CLI emits an envelope whose `result` field holds the model's final
 * TEXT (a string). The analyze.md prompt makes that text end with its own JSON
 * object: `{ "type":"sync", "result":"MISSING_CONTENT"|..., "target_files":[...] }`.
 * So there are two layers named `result`: the CLI envelope's `result` (a string
 * of model text) and the analyze JSON's `result` (the gap-type enum). We unwrap
 * the envelope first, then extract the analyze JSON, then normalize it.
 */
function parseAgentOutput(stdout) {
  let finalText = stdout;
  try {
    const env = JSON.parse(stdout);
    // Envelope: `result` is the model's text. (The analyze JSON's `result` is an
    // enum string, never an object, so we only treat it as the envelope when the
    // OTHER envelope fields are present.)
    if (env && typeof env.result === "string" && ("type" in env || "subtype" in env || "is_error" in env)) {
      finalText = env.result;
    }
  } catch {
    /* not the envelope — treat stdout as the model text directly */
  }
  const obj = lastJsonObject(finalText);
  if (!obj) {
    log("warn", "could not parse analyze JSON from agent output; assuming NO_GAP");
    return normalizeResult({ result: "NO_GAP", reason: "unparseable agent output", target_files: [] });
  }
  return normalizeResult(obj);
}

/**
 * Normalize the analyze.md output object into the shape the rest of this runner
 * consumes. analyze.md emits `{ result: <GAP_TYPE|NO_GAP>, target_files: [...] }`.
 * We derive the booleans/counts the state machine needs from those fields, so the
 * two sides stay in sync even though the prompt owns the canonical contract.
 */
const GAP_TYPES = new Set([
  "MISSING_CONTENT", "OUTDATED_CONTENT", "NEW_PAGE", "STRUCTURAL", "STYLE", "NO_GAP",
]);
function normalizeResult(obj) {
  const raw = obj || {};
  const gapType = GAP_TYPES.has(raw.result) ? raw.result : "NO_GAP";
  const targetFiles = Array.isArray(raw.target_files) ? raw.target_files : [];
  return {
    gapType,
    hasGap: gapType !== "NO_GAP",
    docsChanged: targetFiles.length,
    summary: raw.reason || raw.summary || (gapType === "NO_GAP" ? "none" : gapType),
    severity: raw.severity,
    spendUSD: Number(raw.spendUSD) || undefined,
    raw,
  };
}

/** Find the last top-level {...} JSON object in a string. */
function lastJsonObject(text) {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  // Walk backwards balancing braces to find the matching opener.
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// State mutation: cursor + queue status + runLog
// --------------------------------------------------------------------------

/** Map a normalized analyze result to the terminal queue status. */
function statusFromResult(result) {
  if (!result || !result.hasGap) return "no_gap";
  // The agent edited files in the working tree → the workflow will commit them
  // to the rolling Draft PR branch, so this PR's work is "drafted" (awaiting
  // human review). It only becomes "published" when that doc PR merges, which a
  // separate workflow step records.
  return "drafted";
}

/**
 * Upsert the queue entry for this PR to a given status, then advance the cursor
 * and append a runLog entry. Mutates `state` in place and returns it.
 */
function applyResult(state, { id, pr, mergedAt, status, result, runId, errors, spendUSD, stoppedReason }) {
  // 1. Queue upsert.
  state.queue = state.queue || [];
  let entry = state.queue.find((q) => q.id === id);
  if (!entry) {
    entry = { id, status: "queued" };
    state.queue.push(entry);
  }
  entry.status = status;
  if (result && result.gapType) entry.gapType = result.gapType;
  entry.updatedAt = nowIso();

  // 2. Advance the cursor only on success (don't skip a PR we failed on, so a
  //    retry re-attempts it). Compare by PR number AND merged_at so out-of-order
  //    merges still move the high-water mark forward monotonically.
  if (errors === 0) {
    state.cursor = state.cursor || { lastProcessedPr: null, lastProcessedMergedAt: null };
    const prevPr = Number(state.cursor.lastProcessedPr) || 0;
    if (pr > prevPr) state.cursor.lastProcessedPr = pr;
    if (mergedAt && (!state.cursor.lastProcessedMergedAt || mergedAt > state.cursor.lastProcessedMergedAt)) {
      state.cursor.lastProcessedMergedAt = mergedAt;
    }
  }

  // 3. Append the run log (the dashboard feed + audit trail via git history).
  const gapsFound = status === "drafted" || status === "published" ? 1 : 0;
  state.runLog = state.runLog || [];
  const entryLog = {
    runId,
    prsAnalyzed: 1,
    gapsFound,
    docsChanged: Number(result && result.docsChanged) || 0,
    errors,
    at: nowIso(),
  };
  if (Number.isFinite(spendUSD) && spendUSD > 0) entryLog.spendUSD = spendUSD;
  if (stoppedReason) entryLog.stoppedReason = stoppedReason;
  state.runLog.push(entryLog);

  return state;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) process.env.AUTOSCRIBE_DRY_RUN = "1";

  // Load config + state (the GitHub-native "database"). State may not exist on
  // the very first sync run — start from an empty-but-valid shape.
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config at ${CONFIG_PATH}`);
  }
  const config = readJson(CONFIG_PATH);
  const state = existsSync(STATE_PATH)
    ? readJson(STATE_PATH)
    : { version: 1, cursor: { lastProcessedPr: null, lastProcessedMergedAt: null }, queue: [], runLog: [] };

  const runId = newRunId();
  const { repo, pr, payload } = resolveTarget(config, args);
  const id = `${repo}#${pr}`;
  const mergedAt = payload.mergedAt || payload.merged_at || null;
  log("info", `run ${runId} starting for ${id} (docsDir=${config.docsDir})`);

  // --- Guardrails first (cheap, before any spend) -------------------------
  const guard = checkGuardrails(config, state);
  if (!guard.ok) {
    log("warn", `guardrail stop (${guard.reason}): ${guard.detail}`);
    applyResult(state, {
      id, pr, mergedAt,
      // Leave the PR queued so a later run (under-ceiling / drained queue) retries it.
      status: (state.queue.find((q) => q.id === id) || {}).status || "queued",
      result: null, runId, errors: 0, stoppedReason: guard.reason,
    });
    writeJsonAtomic(STATE_PATH, state);
    // Exit 0: a guardrail stop is an expected, non-error outcome.
    return;
  }

  // --- Mark in_progress and persist immediately ---------------------------
  // So a crash mid-run leaves a visible `in_progress` rather than a lost PR.
  {
    state.queue = state.queue || [];
    let entry = state.queue.find((q) => q.id === id);
    if (!entry) { entry = { id, status: "queued" }; state.queue.push(entry); }
    entry.status = "in_progress";
    entry.updatedAt = nowIso();
    writeJsonAtomic(STATE_PATH, state);
  }

  // --- Do the work --------------------------------------------------------
  let errors = 0;
  let result = null;
  try {
    const { title, diff, files } = await fetchPr(repo, pr);
    if (!diff || !diff.trim()) {
      // Mirror analyze.md's INSUFFICIENT_INPUT guard.
      log("warn", "empty diff — recording NO_GAP (INSUFFICIENT_INPUT)");
      result = normalizeResult({ result: "NO_GAP", reason: "INSUFFICIENT_INPUT: empty diff", target_files: [] });
    } else {
      const prInput = { repo, pr, title, diff, files, docsDir: config.docsDir, style: config.style };
      result = runAgent({ config, prInput });
    }
  } catch (err) {
    errors = 1;
    log("error", `processing ${id} failed: ${err.message}`);
    result = normalizeResult({ result: "NO_GAP", reason: `error: ${err.message}`, target_files: [] });
  }

  // --- Record terminal state ----------------------------------------------
  const status = errors > 0
    ? "in_progress" // keep it visible/retryable; don't claim a terminal state on failure
    : statusFromResult(result);
  applyResult(state, {
    id, pr, mergedAt, status, result, runId, errors,
    spendUSD: (result && result.spendUSD) || undefined,
  });
  writeJsonAtomic(STATE_PATH, state);

  log("info", `run ${runId} done: ${id} -> ${status} (gapType=${result && result.gapType}, errors=${errors})`);
  // Non-zero exit on error lets the workflow surface a failed run.
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  // Last-resort guard: never crash without a clear message. State writes above
  // are atomic, so a throw here cannot corrupt state.json.
  log("error", `fatal: ${err.stack || err.message}`);
  process.exit(1);
});
