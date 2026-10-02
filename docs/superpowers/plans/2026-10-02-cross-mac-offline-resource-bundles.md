# Cross-Mac Offline Resource Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the selected Markdown material, its complete offline speech package, and already-generated scenario pictures as a portable ZIP that can be imported and used on another Mac without model files.

**Architecture:** Add a versioned ZIP codec and a server-side import/export flow that verifies a complete audio package, packages only existing images, remaps path-sensitive keys on import, and swaps the one active speech package only after validation. The 8788 app remains usable without models for imports and offline playback; separate speech/image capability checks disable generation while preserving cached media.

**Tech Stack:** Node.js 22 built-in HTTP, filesystem, crypto, child-process, and test modules; macOS `zip`/`unzip`; TypeScript server; browser JavaScript-compatible TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-02-cross-mac-offline-resource-bundles-design.md`

## Global Constraints

- Services bind to `127.0.0.1`; bundle contents are not uploaded to a remote service.
- The compressed archive and expanded contents are each limited to 2 GiB; entry count is capped at 10,000; included Markdown remains within the existing 10 MB limit.
- Keep one active offline speech package. Import replaces it only after all required speech resources validate; existing scenario pictures for other materials remain cached.
- The portable ZIP contains the Markdown, every WAV in the complete active package, and only scenario pictures that already exist. It never contains model weights, Python environments, or unrelated outputs.
- Import must work without speech/image models, Python, or MLX. The 8788 service requires Node.js 22 or later.
- Without speech capability, cached offline playback remains available, real-time synthesis and cache generation are disabled, and missing clips never fall back to synthesis. Without image capability, cached pictures remain visible and generation is disabled.
- Use macOS system `zip`/`unzip`; do not add a compression-library dependency.

## Review Focus

- Duplicate, absolute, traversal, or unexpected ZIP entry names must be rejected before any file is written. Pin this in Task 1's entry-list validator tests.
- A valid-looking ZIP with inconsistent sizes, hashes, media signatures, or expanded size must be rejected. Pin this in Task 1's archive validation tests.
- A bundle whose Markdown lines do not exactly match its WAV turn IDs must not replace the active package. Pin this in Task 3's import API tests.
- An imported material moved from a different absolute source path must still find its speech and scenario images under the new local path. Pin this in Task 3's cross-path import test.
- With models absent, an offline miss must not call live synthesis and generation APIs must return unavailable. Pin this in Task 4's model-free API tests.

---

### Task 1: Add a versioned, validated ZIP codec

**Files:**
- Create: `speech/resource-bundle.ts`
- Create: `speech/resource-bundle.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `ResourceBundleManifestV1 = { format: "ket-speaking-resource-bundle"; version: 1; material: { entry: "material.md"; filename: string; byteLength: number; sha256: string }; speech: { profile: "default" | "current"; profileKey: string; total: number; clips: Array<{ id: string; entry: string; cacheKey: string; byteLength: number; sha256: string }> }; images: Array<{ groupId: string; variant: 1 | 2; entry: string; byteLength: number; sha256: string }> }`. Audio entries map stable turn IDs to `audio/<turn-id>.wav`; image entries map Part 2 group IDs and variant `1 | 2` to `scenario-images/<group-id>-<variant>.png`.
- Produces `ArchiveEntryDescriptor = { name: string; kind: "file" | "directory" | "symlink" | "hardlink" | "other" }` and `validateResourceBundleEntries(input: { entries: ArchiveEntryDescriptor[]; allowedNames: Set<string> }): void`, rejecting duplicate names, unsafe paths, every non-file entry, names outside the manifest-derived allowlist, and entry counts over 10,000. The only allowed names are `manifest.json`, `material.md`, and exact audio/image entry names declared by the parsed manifest.
- Produces `validateResourceBundleSizes(input: { compressedBytes: number; expandedBytes: number; markdownBytes: number }): void`, enforcing the exact caps from the Global Constraints.
- Produces `writeResourceBundleArchive(input: { manifest: ResourceBundleManifestV1; sources: Array<{ entry: string; sourcePath: string }>; archivePath: string }): Promise<void>`.
- Produces `readResourceBundleArchive(input: { archivePath: string; destinationDirectory: string }): Promise<ValidatedResourceBundle>`, where `ValidatedResourceBundle` is `{ manifest: ResourceBundleManifestV1; materialPath: string; audioPaths: Map<string, string>; imagePaths: Map<string, string> }`; image map keys are `${groupId}:${variant}`. It first enumerates central-directory names and file types, rejects duplicate/unsafe entries, reads and validates the unique manifest, derives the exact allowlist, then streams only allowlisted entry data into server-selected paths while verifying schema, limits, lengths, SHA-256 values, and WAV/PNG signatures. No archive path is ever passed to an extract-to-disk operation.

- [ ] **Step 1: Write validator and round-trip tests first** with these names and assertions: `validateResourceBundleEntries_rejectsUnsafeDuplicateAndNonFileEntries` rejects duplicate `manifest.json`, absolute, traversal, backslash, symlink, hardlink, directory, non-file, and manifest-unlisted names before creating payload files; `readResourceBundleArchive_roundTripsValidBundle` preserves manifest, Markdown, WAV, and partial images; `readResourceBundleArchive_rejectsUnsupportedVersionAndBadMedia` rejects version, duplicate manifest, hash, length, WAV, and PNG mismatches and cleans its staging directory on failure; `validateResourceBundleSizes_enforcesAllCaps` rejects sizes one byte over each cap.
- [ ] **Step 2: Run the focused test file and confirm it fails** because the codec exports do not yet exist.

  Run: `node --experimental-strip-types --test speech/resource-bundle.test.ts`

  Expected: FAIL on missing `speech/resource-bundle.ts` exports.
- [ ] **Step 3: Implement manifest types, allowlist validation, ZIP creation, and safe ZIP reading** in `speech/resource-bundle.ts`. Use argument arrays with the system `zip`/`unzip` commands, omit directory entries when creating archives, and inspect archive central-directory metadata before reading payloads so symlink and other non-regular entries are rejected. Read individual entries to server-generated paths with `unzip -p`; never extract arbitrary archive paths. Enforce 2 GiB compressed and expanded limits, 10,000 entries, and the 10 MB Markdown limit while receiving uploads and decompressing entries. Validate the manifest filename as a display basename and strip control characters before constructing `Content-Disposition`.
- [ ] **Step 4: Re-run the focused tests** and verify every valid round-trip passes and each malformed archive is rejected before promotion.

  Run: `node --experimental-strip-types --test speech/resource-bundle.test.ts`

  Expected: all resource-bundle tests pass with exit code 0.
- [ ] **Step 5: Add `test:resource-bundles` to `package.json`** as `node --experimental-strip-types --test speech/resource-bundle.test.ts`.
- [ ] **Step 6: Run the new package script** and confirm it reports the same passing codec tests.

  Run: `npm run test:resource-bundles`

  Expected: all resource-bundle tests pass with exit code 0.
- [ ] **Step 7: Commit the codec and tests.**

  Commit: `feat: add validated offline resource bundle format`

### Task 2: Export the complete speech package and existing images

**Files:**
- Modify: `speech/server.ts`
- Create: `speech/resource-bundle-api.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Task 1's `ResourceBundleManifestV1`, `writeResourceBundleArchive`, and `readResourceBundleArchive`.
- Adds `GET /api/resource-bundles/export?filePath=<path>&materialKey=<key>`; success streams a `<safe-material-name>.ketpack.zip` attachment. It returns `409` when the material has no complete, matching audio package.
- Adds `TTS_OUTPUT_DIR`, `TTS_MODEL_PATH`, `TTS_IMAGE_MODEL_PATH`, and `MFLUX_CLI_PATH` overrides to `speech/server.ts`, each resolved from the project root when relative and defaulting to current paths. These permit isolated API tests with missing-model paths without changing production defaults. API tests launch the server as a child process with `TTS_PORT` set to an available test port and terminate it in cleanup.

- [ ] **Step 1: Write export API tests first** that start the speech server on a temporary port/output directory. `exportResourceBundle_includesMaterialCompleteAudioAndOnlyExistingImages` asserts exact archive entries, a safe `.ketpack.zip` attachment filename, and no model files; `exportResourceBundle_rejectsMissingIncompleteOrMismatchedAudioPackage` asserts HTTP `409`.
- [ ] **Step 2: Run the API tests and confirm they fail** because the resource routes and test path overrides do not exist.

  Run: `node --experimental-strip-types --test speech/resource-bundle-api.test.ts`

  Expected: the server returns `404` for the new routes or cannot use the isolated output directory.
- [ ] **Step 3: Implement export assembly** in `speech/server.ts`: verify the active manifest is complete for the requested material, verify every WAV hash and the exact ordered turn-ID coverage against the Markdown parser, collect only existing images for current Part 2 groups, build a temporary bundle, and stream it with a safe attachment filename. Serialize export/import and audio-cache promotion so an archive cannot capture a package mid-replacement.
- [ ] **Step 4: Run the export API tests** and verify the ZIP contains every required WAV and only existing scenario images.

  Run: `node --experimental-strip-types --test speech/resource-bundle-api.test.ts`

  Expected: all export API tests pass with exit code 0 and no model worker is started.
- [ ] **Step 5: Add `speech/resource-bundle-api.test.ts` to `test:resource-bundles`** alongside `speech/resource-bundle.test.ts`.
- [ ] **Step 6: Run the combined codec/export test script** and confirm it passes.

  Run: `npm run test:resource-bundles`

  Expected: all codec and export API tests pass with exit code 0.
- [ ] **Step 7: Commit the exporter and tests.**

  Commit: `feat: export portable speech and image bundles`

### Task 3: Import bundles, remap local keys, and preserve old resources on failure

**Files:**
- Modify: `speech/server.ts`
- Create: `speech/resource-bundle-store.ts`
- Create: `speech/resource-bundle-store.test.ts`
- Modify: `speech/resource-bundle-api.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Task 1's `readResourceBundleArchive` and Task 2's `GET /api/resource-bundles/export` format.
- Adds `POST /api/resource-bundles/import` with `Content-Type: application/zip`; success returns `{ filePath, materialKey, sections, itemCount }` for the imported Markdown. Reject import with `409` while an audio-cache job is running so two operations cannot race to replace the active package.
- Saves Markdown to `outputs/speech-practice/imported-material.md`, recomputes its path-sensitive local `materialKey`, and maps image entries by Part 2 `groupId` and variant to the local `illustrationKey`.
- Produces `promoteResourceBundleFiles(input: { moves: Array<{ stagedPath: string; destinationPath: string }>; backupDirectory: string; fileOps?: ResourceBundleFileOps }): Promise<void>` in `speech/resource-bundle-store.ts`. `ResourceBundleFileOps` exposes `mkdir(path, { recursive: true })`, `rename(source, destination)`, and `rm(path, { recursive: true, force: true })`, each returning a promise, so tests can inject a deterministic promotion failure and verify rollback.

- [ ] **Step 1: Add import and promotion tests first**. `importResourceBundle_remapsAudioAndImagesToNewMaterialPath` asserts imported Markdown is selected and both local media routes return the packaged bytes; `importResourceBundle_allowsPartialImages` asserts absent image variants stay absent and pre-existing images for other scenario keys remain unchanged; `importResourceBundle_rejectsInvalidBundleWithoutReplacingActiveFiles` asserts unsupported version, bad hash, and ordered turn mismatch leave the active manifest, imported Markdown, and existing picture bytes unchanged. `promoteResourceBundleFiles_restoresAllDestinationsAfterInjectedRenameFailure` injects a failure after one move and asserts all previous destinations are restored.
- [ ] **Step 2: Run the import API tests and confirm they fail** because the import route returns `404`.

  Run: `node --experimental-strip-types --test speech/resource-bundle-api.test.ts speech/resource-bundle-store.test.ts`

  Expected: import requests fail at the missing route and the transaction test fails on the missing store export; Task 2's export tests still pass.
- [ ] **Step 3: Implement streaming upload and validation** in `speech/server.ts`: enforce `application/zip` and the compressed limit, stage the archive under `outputs/speech-practice`, call `readResourceBundleArchive`, parse `material.md`, and require the ordered parsed turn IDs to exactly equal the manifest.
- [ ] **Step 4: Implement `promoteResourceBundleFiles`** in `speech/resource-bundle-store.ts`: move existing destinations to unique backups, promote staged destinations, and on any rename failure remove promoted files and restore all backups. Use the injected `fileOps` defaults for real filesystem operations. Promote the imported Markdown and speech package as one rollback-protected operation; commit only imported image files and preserve all other scenario folders.
- [ ] **Step 5: Implement import path remapping and call the transaction helper**: save Markdown to `outputs/speech-practice/imported-material.md`, compute the new path-sensitive `materialKey`, preserve imported profile metadata, clip IDs/cache keys, and audio hashes, and write an app-native `OfflineManifest` with the new material key. Promote the complete staged offline-cache directory to `OFFLINE_CACHE_DIR` in one rename. Map each imported Part 2 `groupId` to the parsed group's context/dialogue and local `illustrationKey`; include only present image files in the move list so absent variants and other scenario folders remain unchanged.
- [ ] **Step 6: Run import API and transaction tests** and verify imported WAV/image routes serve the correct bytes under new keys, invalid imports preserve existing resources, and a simulated promotion failure restores the old files.

  Run: `node --experimental-strip-types --test speech/resource-bundle-api.test.ts speech/resource-bundle-store.test.ts`

  Expected: all import/export API and transaction tests pass with exit code 0; no model worker is started.
- [ ] **Step 7: Extend `test:resource-bundles`** to include `speech/resource-bundle-store.test.ts`.
- [ ] **Step 8: Run `npm run test:resource-bundles`** and confirm all three test files pass.
- [ ] **Step 9: Commit the importer and tests.**

  Commit: `feat: import portable offline practice bundles`

### Task 4: Add model-free UI behavior and guard generation paths

**Files:**
- Modify: `speech/server.ts`
- Modify: `speech/index.html`
- Modify: `speech/app.ts`
- Modify: `speech/styles.css`
- Modify: `web/server.ts`
- Modify: `web/app.ts`
- Create: `web/server.test.ts`
- Create or extend: `speech/resource-bundle-api.test.ts`

**Interfaces:**
- Extends `GET /api/config` with `speechModelReady`, `speechRuntimeReady`, `imageModelReady`, `imageRuntimeReady`, `archiveToolsReady`, and aggregate `speechAvailable`/`imageAvailable`, retaining `modelReady`, `runtimeReady`, and `illustrationReady` compatibility fields. `imageRuntimeReady` reflects the configured mflux executable; archive readiness checks both `zip` and `unzip`.
- Consumes the import response from Task 3 to load the imported sections and refresh audio status without another path selection.
- Export button is enabled only for a complete matching offline package; import is available before a Markdown material is loaded.
- Uses `MFLUX_MODEL_PATH` and `MFLUX_CLI_PATH` test overrides in `web/server.ts`; the `8787` production defaults remain unchanged. `TTS_OUTPUT_DIR` and model-path overrides isolate the 8788 integration tests.

- [ ] **Step 1: Add model-free API tests first**. In `speech/resource-bundle-api.test.ts`, `config_reportsIndependentCapabilitiesWhenModelsAreMissing` asserts speech/image readiness is false independently; `offlinePlaybackWorksWithoutModelsAndSynthesisDoesNot` imports a bundle, asserts its WAV route returns `200`, and asserts synthesis/cache-generation/image-generation return `503`. In a new `web/server.test.ts`, `imageStudioRejectsMissingModelOrCli` tests a missing model and a valid-shaped test model with a missing CLI, each returning `503` from `/api/generate`.
- [ ] **Step 2: Run those API tests and confirm they fail** on the absent capability flags or an unguarded route.

  Run: `node --experimental-strip-types --test speech/resource-bundle-api.test.ts web/server.test.ts`

  Expected: at least one new capability/API assertion fails before implementation.
- [ ] **Step 3: Implement independent model readiness reporting and server guards**. Keep existing field aliases; check speech model/runtime before synthesis or cache generation, and image model/CLI before illustration generation. Add the `MFLUX_CLI_PATH` override to `web/server.ts`; preserve the existing 8787 image-generation guard and make its missing-model status explicit.
- [ ] **Step 4: Add import/export controls and browser behavior**. Place import above the source path; show upload/validation progress; on success set the imported path and render the returned material. Show export only when archive tools are ready and the active offline package matches and is complete; disable both bundle actions when archive tools are unavailable. With no speech capability, switch to a distinct `offline-only` playback mode, disable mode selection and cache-generation controls, and make a missing clip show an unavailable message without calling `/api/synthesize`. With speech capability, retain current realtime/offline-first behavior. With no image capability, keep existing galleries visible and disable image generation with an explanatory status.
- [ ] **Step 5: Run the API tests** and verify imported offline WAV playback works without models while speech/image generation APIs return `503`.

  Run: `node --experimental-strip-types --test speech/resource-bundle-api.test.ts web/server.test.ts`

  Expected: all capability/API tests pass with exit code 0; no Python or MLX worker starts.
- [ ] **Step 6: Add `web/server.test.ts` to `test:resource-bundles`, then inspect both model-free browser pages**: on 8788 import a test bundle even when the configured default Markdown path is missing, play one cached sentence, confirm no `/api/synthesize` request occurs, and verify speech/image generation controls are disabled while imported pictures remain visible; on 8787 confirm its model-unavailable state and disabled generation button.
- [ ] **Step 7: Commit model detection and UI behavior.**

  Commit: `feat: support model-free offline resource playback`

### Task 5: Document export, import, and model-free startup

**Files:**
- Modify: `README.md`
- Modify: `speech/README.md`
- Modify: `web/README.md`

**Interfaces:**
- Documents `<material>.ketpack.zip`, its Markdown/audio/available-image contents, export readiness, import replacement behavior, and integrity failures.
- Documents second-Mac setup using Node.js 22+, `npm run start:tts`, and `http://127.0.0.1:8788`; explicitly says not to run `install.command` when the user does not want model downloads.
- Documents that 8787 generation and 8788 live synthesis/image generation stay disabled without their respective local model capabilities while imported media remains usable.

- [ ] **Step 1: Update the three README files** to explain the two transfer flows, model-free startup, what is included/excluded, one-active-audio-package behavior, and which controls are unavailable without models.
- [ ] **Step 2: Review the docs against the routes and controls** and run `git diff --check`.

  Expected: every documented path, command, and URL matches the implemented app; `git diff --check` exits 0.
- [ ] **Step 3: Commit the documentation.**

  Commit: `docs: explain portable offline resources and model-free startup`

### Final verification

- [ ] Run `npm run test:resource-bundles` and confirm all codec, 8788 API, store, and 8787 API tests pass.
- [ ] Run `node --experimental-strip-types --check` for each of `speech/app.ts`, `speech/server.ts`, `speech/resource-bundle.ts`, `web/app.ts`, and `web/server.ts`; confirm each exits 0.
- [ ] Run `git diff --check` and inspect `git status`.
- [ ] Review the full change against the spec, paying special attention to rollback, archive path handling, independent model capability gates, and no-model import/playback.
