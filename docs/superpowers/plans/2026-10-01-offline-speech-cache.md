# Offline Speech Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Generate one replaceable local speech package per selected Markdown file, keep practice responsive during generation, and play cached clips first with real-time fallback.

**Architecture:** Keep the existing single MLX worker and add a shared priority scheduler so interactive requests outrank background cache clips. Persist a single active package plus resumable staging files and a manifest under `outputs/speech-practice/`. The browser starts and polls jobs, lets the learner select playback mode, and falls back to existing live synthesis when an offline clip is unavailable.

**Tech Stack:** Node.js built-in HTTP/filesystem/crypto modules, the existing TypeScript browser app, one persistent Python MLX worker, HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-10-01-offline-speech-cache-design.md`

## Global Constraints

- Keep the web server bound to `127.0.0.1`; do not send speech, settings, or files to a network service.
- Keep using the existing single MLX worker; schedule one model request at a time.
- Store the one active package under `outputs/speech-practice/offline-audio/`; keep incomplete staging data separate from playable assets.
- Initial cache generation uses the fixed default tags; explicit replacement uses a snapshot of current tags.
- Replacement becomes active only after every clip is generated; preserve the existing active package on failure.
- Offline-priority playback falls back to real-time synthesis with current settings when the active package lacks a matching clip.
- Do not add dependencies or automated tests; use the direct local-app review specified in the approved spec.

## Review Focus

- A changed or reloaded Markdown file must not resolve clips from a different material fingerprint.
- Current settings changing during cache generation must not alter the in-flight profile snapshot.
- A failed replacement must leave the previous complete package usable.
- A foreground synthesis request arriving during background work must run before the next queued cache clip.
- A missing offline clip must trigger current-settings real-time synthesis and report the fallback clearly.

---

### Task 1: Prioritize foreground synthesis over cache work

**Files:**
- Modify: `speech/server.ts`

**Interfaces:**
- Produces: `enqueueSpeech(request: TtsRequest, priority: "foreground" | "background"): Promise<string>` returning the generated worker file name.
- Produces: one in-flight worker request at a time; after each response, dispatch the oldest foreground request before any background request.
- Preserves: `POST /api/synthesize` behavior and response shape, with requests submitted at `foreground` priority.

- [x] Add foreground and background FIFO queues and one active request around the existing worker message handler.
- [x] Route ordinary synthesis through `enqueueSpeech(..., "foreground")`; dispatch the next queued request after success, failure, worker close, or timeout.
- [x] Keep all work asynchronous so HTTP requests and browser interactions remain responsive while MLX generates an utterance.
- [x] Review the scheduler path to confirm a newly queued foreground request is selected before the next queued background request and only one worker request is sent at a time.

### Task 2: Build the single active offline package and job API

**Files:**
- Modify: `speech/server.ts`

**Interfaces:**
- Extends `POST /api/parse` response with `materialKey: string`, the SHA-256 identity of normalized absolute file path plus file contents.
- Adds `POST /api/audio-cache/jobs` accepting `{ filePath, materialKey, profile, items }`, where `profile` is `"default" | "current"` and each item contains `{ id, text, language, instruct }`; it returns a job ID immediately.
- Adds `GET /api/audio-cache/jobs/:jobId` returning `{ id, state, completed, total, currentItem, message, error? }`.
- Adds `GET /api/audio-cache/status?materialKey=...` returning whether the active complete package matches the loaded material and its profile/count.
- Adds `GET /api/offline-audio/:materialKey/:turnId` serving only a WAV authorized by the active manifest.

- [x] Extend parse results with a material fingerprint; recompute and compare it when a cache job starts so a file edited after loading must be re-read.
- [x] Validate cache job profile, material key, turn IDs, text, language, instructions, item count, and request body size before creating any files.
- [x] Add cache-job state and a single-job guard; queue cache items at background priority and update completed count/current turn after each generated utterance.
- [x] Save generated WAVs in a staging directory and persist enough manifest data to resume verified staging clips only for the same material and profile fingerprint.
- [x] On full success, promote staging to the active directory, then remove the previous package; on error, keep the previous active directory and expose an actionable failed-job status.
- [x] Serve audio only after checking the active manifest's material key and turn ID; derive every disk path beneath the configured output directory.
- [x] Add package status lookup from the persisted manifest so the browser can recover cache state after a page refresh.

### Task 3: Add cache controls, background progress, and playback modes

**Files:**
- Modify: `speech/index.html`
- Modify: `speech/app.ts`

**Interfaces:**
- Consumes: `materialKey` from `/api/parse`, the cache job/status endpoints, and the offline WAV route from Task 2.
- Produces: playback preference `"realtime" | "offline-first"`, stored in browser local storage.
- Produces: initial cache jobs using default `DEFAULTS`; replacement jobs using an immutable snapshot of current tag settings.

- [x] Add a cache panel that shows package status and total spoken lines, starts first-time default generation, and offers explicit current-settings replacement when a package exists.
- [x] Poll job status asynchronously and announce progress/failure in a status region without disabling the practice list or settings controls.
- [x] Add real-time and offline-first playback options; keep real-time as the initial preference and restore the saved preference on page load.
- [x] In offline-first mode, request the matching package clip before synthesis; if unavailable or mismatched, announce the fallback and call the existing real-time synthesis path using current settings.
- [x] Keep cached playback independent of current tags and make replacement job input immutable so settings edits affect only later work.
- [x] Refresh package status after loading another material, finishing a generation job, or recovering the page after reload.

### Task 4: Polish the controls and document local storage behavior

**Files:**
- Modify: `speech/styles.css`
- Modify: `speech/README.md`

- [x] Style cache controls and progress states in the existing light Claymorphism design, preserving visible keyboard focus and 44px minimum touch targets.
- [x] Document first-time default generation, current-settings replacement, single-package storage, background priority, offline-first fallback, and the output directory.
- [x] Review the running local app's cache controls and playback-mode feedback without starting a full-material generation job or replacing the user's audio package.
- [x] Review the local-clip, missing-clip fallback, and failed-replacement paths in code; confirm all active audio paths are manifest-gated and staging paths are never served.
- [x] Document that actual full-material generation and replacement is user-triggered; do not initiate it during implementation review.

---

## Completion record

- All four tasks completed in the selected Native workspace.
- Ruling: the checkout has no `.git`, so no worktree or rollback history was available; changes were made directly in the selected workspace.
- Ruling: automated tests were excluded by the approved scope; validation used syntax checks, code review, and direct local-page inspection.
- Syntax checks passed for `speech/app.ts` and `speech/server.ts`; the existing local page loaded the selected Markdown and showed 140 lines plus cache and playback controls.
- Independent review finding fixed: stale playback and parse requests are invalidated across material switches.
- Deferred minor: cache status counts WAV files by presence without rechecking their manifest hash before displaying the count.
- No automated tests, live speech synthesis, or full-material cache generation were run.
