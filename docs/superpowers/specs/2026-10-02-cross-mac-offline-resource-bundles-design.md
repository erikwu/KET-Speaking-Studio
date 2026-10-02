# Cross-Mac Offline Resource Bundles

## Goal

Let a learner generate speech and scenario pictures on one Apple Silicon Mac, export the learning material and generated assets as one file, and import that file into the same app on another Mac without installing either MLX model there.

The secondary Mac must still be able to start the KET Speaking web app, load the included Markdown material, play the packaged audio, and view packaged pictures. Real-time synthesis and image generation remain unavailable until their respective local models and runtimes are installed.

## Approved user behavior

- Export is available for the currently loaded material only after its active offline speech package is complete and every WAV passes integrity checks.
- The portable ZIP includes the original `.md`, every generated WAV for that material, and only scenario pictures that already exist. It never includes model weights, Python environments, or unrelated outputs.
- The ZIP is self-describing and versioned. It includes a manifest with stable turn/scenario mappings, sizes, and SHA-256 hashes. It does not store absolute source paths.
- Import validates the complete archive and its Markdown/audio mapping before changing active resources. It saves the Markdown in the app's local imported-material location, makes it the current material, and replaces the one active offline speech package. A failed import preserves the previous active package and imported material.
- Imported pictures are remapped to the importing Mac's local scenario keys and merged into the scenario-image cache. Existing pictures for other materials are preserved.
- Resource import works before any material is loaded and does not require a speech model, image model, Python environment, or MLX runtime. Starting the 8788 service requires Node.js 22 or later.
- If the speech model or MLX-Audio runtime is absent, the app supports playback from a complete imported offline package. It disables live speech synthesis and cache generation/replacement. If a requested offline clip is missing or invalid, the app reports that it is unavailable and does not attempt synthesis.
- If the image model or mflux runtime is absent, the app continues to show cached scenario pictures and disables their generation. The standalone 8787 image studio also keeps image generation disabled when its model or CLI is unavailable.
- Speech and image capability detection are independent: one missing model does not disable the other model's available features.
- Existing local-only behavior remains: services bind to `127.0.0.1`; bundle contents are not uploaded to a remote service.

## Bundle format

Use a regular ZIP file with a versioned `manifest.json` and a strict allowlist of entry names:

```text
manifest.json
material.md
audio/<turn-id>.wav
scenario-images/<part2-group-id>-<variant>.png
```

The manifest records the bundle format version, display filename, Markdown content hash, active speech profile metadata, ordered turn IDs, each WAV's size and SHA-256, and a possibly partial list of generated pictures keyed by Part 2 group and variant. The archive does not contain an absolute source path. A version the app does not support, duplicate entry names, unsafe paths, unexpected file types, absent required turns, invalid WAV/PNG content, size-limit violations, or a hash mismatch rejects the whole import.

ZIP creation and inspection use macOS system `zip`/`unzip` tools; no model or compression library is required. Import reads only allowlisted entries and writes them to app-generated paths rather than extracting arbitrary archive paths.

## Components and data flow

### 8788 KET Speaking service

- Extend the existing audio-cache panel with **Export resource bundle** and **Import resource bundle** controls.
- Export gathers the loaded Markdown, verifies the active offline manifest and all WAV hashes, enumerates existing images for parsed Part 2 groups, writes a staged ZIP, then streams it as a browser download. It is enabled only for a complete cache matching the loaded material.
- Import accepts a ZIP even when no Markdown is currently loaded. The server streams it to a bounded staging file, validates its manifest and entries, checks the Markdown parses into the exact ordered turn IDs in the manifest, validates all required WAVs and optional images, and builds a complete staged local resource set.
- The importer writes the included Markdown to `outputs/speech-practice/imported-material.md`. It recalculates the path-sensitive local `materialKey` for that path and rewrites the imported audio manifest to that key. It maps packaged Part 2 group/variant images through the existing local `illustrationKey` function so current routes find them after import.
- Only after all validation succeeds does the server promote the staged speech package and Markdown, replacing the current active speech package. Promotion uses same-filesystem staging and rollback backups. Imported pictures are committed atomically per file; a rollback journal restores overwritten pictures and removes newly added pictures if a later promotion step fails. Other scenario folders are left intact.
- The import response returns the new local Markdown path and parsed material data; the browser selects it, renders the sections, and refreshes cache status without requiring a model.
- Invalid, incomplete, oversized, unsupported, or corrupted bundles return a user-readable error and leave the previous active package and material in place.

### Model capability and UI state

- `/api/config` adds `speechModelReady`, `speechRuntimeReady`, `imageModelReady`, and `imageRuntimeReady` booleans. Existing `modelReady`, `runtimeReady`, and `illustrationReady` fields remain available for compatibility.
- The 8788 page presents import before the current Markdown path workflow so a fresh model-free installation can import its included material immediately, even if the configured default Markdown path does not exist.
- With no speech capability, selecting realtime mode and starting either cache generation action are disabled. A valid imported offline package remains playable. A missing clip reports a clear unavailable message without calling `/api/synthesize`.
- With no image capability, scenario galleries continue to load local PNGs and generation buttons remain disabled with an explanatory status.
- The 8787 page's existing model readiness state remains visible; its generation API also rejects generation when the local image model or CLI is unavailable.

### Model-free startup on a second Mac

After obtaining the project files and installing Node.js 22+, run `npm run start:tts` from the project root and open <http://127.0.0.1:8788>. Do not run `install.command` on a model-free machine because it installs model runtimes and downloads model files. Importing the ZIP makes its Markdown the active document. The 8787 image generation service is not needed to play imported material or view imported scenario pictures.

## Integrity, safety, and recovery

- Limit the compressed archive and expanded contents to 2 GiB each, cap the entry count at 10,000, and keep the included Markdown within the existing 10 MB limit. Enforce limits while streaming and before promotion.
- Reject path traversal, absolute paths, duplicate names, directory entries outside the schema, symlinks, and unexpected file types. Never extract the archive directly into the project or output directory.
- Restrict IDs to the same character sets used by current turn/group identifiers; derive all output paths on the server.
- Verify manifest version/schema, material hash and parse result, exact audio turn coverage, declared lengths, WAV/PNG signatures, and SHA-256 values.
- Keep one active offline speech package, matching the existing product decision. A valid import replaces it only after all required speech resources are complete. Existing scenario images for other materials remain cached.
- Treat model readiness as a server-side capability check as well as a disabled UI state. Direct generation requests must fail with an actionable unavailable-model response.
- Keep model files out of the bundle and preserve `/models/` and generated output ignore rules.

## Verification plan

Use Node's built-in test tooling for deterministic bundle helpers and local API behavior; no MLX inference or model download is needed. Cover successful export/import, Markdown and media mapping across different source paths, partial picture inclusion, bad version/path/duplicate-entry/hash/size rejection, and preservation of the previous active package after import failure. Verify model-free startup, offline playback without a synthesis request, and server rejection of speech/image generation when their capabilities are absent. Also run syntax and `git diff --check` verification.

## Out of scope

- Multiple active offline speech packages or voice profiles.
- Packaging model checkpoints, runtimes, generated speech that is not in the complete active package, or non-generated scenario images.
- Cloud transfer or any network service outside the local app.
- Automatically generating missing audio or pictures during export/import.
- Changing the Markdown parser or synthesizing replacements for missing imported media.
