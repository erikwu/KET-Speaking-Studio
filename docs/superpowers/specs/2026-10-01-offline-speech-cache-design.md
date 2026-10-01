# Offline Speech Cache Design

## Goal

Let learners generate and keep one complete local speech package for the selected Markdown practice material, continue practicing while it generates, and play cached clips first with real-time synthesis as a fallback.

## User-approved behavior

- After a Markdown file is loaded, the app can generate speech for every spoken line across Part 1 / Phase 1, Part 1 / Phase 2, and Part 2.
- The first package uses the fixed default voice and delivery tags already defined by the app.
- The learner can explicitly regenerate and replace the package using the currently selected voice and delivery tags.
- Only one completed offline package is active at a time. It belongs to one material and one voice profile. A new package replaces it only after all clips finish successfully; a failed replacement preserves the previous package.
- Batch synthesis runs as a background job. It does not block page interaction or disable practice controls. Foreground play requests take priority over queued batch clips.
- Playback has real-time and offline-priority modes. In offline-priority mode, the app plays a matching local clip when available; otherwise it synthesizes the sentence in real time using the current settings. The fallback does not mutate the offline package.
- Changing voice tags does not alter existing offline clips. The learner must use the explicit regenerate action for the new settings to affect the offline package.
- Audio remains local under `outputs/speech-practice/`; no network service is introduced.

## Existing system

The TypeScript server in `speech/server.ts` parses Markdown, starts one persistent `mlx_worker.py` process, and handles one-sentence synthesis requests. The browser app in `speech/app.ts` builds speech instructions from the selected tags and plays returned WAV files. The worker serializes requests through its standard input and writes generated WAV files under `outputs/speech-practice/`.

## User experience

1. Loading material shows the total spoken-line count and the current offline-package status for that material.
2. The cache control starts initial generation with fixed defaults, or offers an explicit “regenerate with current settings and replace” action when a package exists.
3. A progress status shows completed clips, total clips, and the current phase. Failure text identifies the failed item and leaves the prior complete package available.
4. Practice controls stay usable while batch generation runs. Real-time play requests are scheduled ahead of remaining batch work.
5. The playback selector offers “real-time synthesis” and “offline first”. Offline-first uses the matching local WAV or displays that real-time synthesis is being used as a fallback.
6. A short note explains that offline clips use their saved voice profile and that changing tags requires regenerating the package.

## Data and storage

- A material identity includes the normalized source path and a content hash so edits or switching files cannot accidentally play stale clips.
- Each clip identity includes the material identity, stable turn ID, spoken text, language, and a synthesis-profile fingerprint.
- The active package contains one WAV per spoken turn and a manifest describing the source material, selected profile, and turn-to-file mapping.
- Generation writes to a staging directory. The server promotes the staged package only after every clip succeeds, then removes the previous active package. Staging files are not considered playable offline assets.
- Initial generation uses the app's fixed `DEFAULTS`; replacement generation snapshots the current tag selections at job start so later UI changes do not alter an in-flight job.

## Server behavior

- Add a background cache job API that accepts the material identity, ordered spoken turns, and a profile mode (`default` or `current`). The request returns a job ID promptly.
- Add a job-status API reporting state, completed/total counts, current turn, and an actionable error on failure.
- Add a local asset lookup/serve route that only serves turns present in the active manifest for the requested material identity.
- Use a shared scheduler for model requests. A foreground synthesis request has priority over batch work; batch work yields after each completed utterance. The existing single MLX worker remains the only model process.
- Validate request size, turn IDs, text, language, profile mode, and paths. All cache paths are derived server-side inside the project output directory.
- A failed batch is not promoted. A retry may reuse verified clips from the same staging package and profile.

## Out of scope

- Multiple offline packages or multiple saved voice profiles.
- Browser-only storage such as IndexedDB as the source of offline audio.
- Parallel MLX workers, a second model process, cloud synthesis, automatic cache deletion controls, and cancellation controls.
- Changing the current Markdown parsing format or the image-generation workflow.

## Acceptance criteria

- Loading a material exposes a cache action that covers every spoken turn in all parsed sections.
- Initial batch generation uses fixed default tags regardless of current tag selections.
- Explicit regeneration uses a snapshot of the currently selected tags and replaces the single active package only after success.
- Batch progress is visible while the app remains interactive.
- A foreground play request is serviced before the next queued batch clip.
- Offline-first playback serves the matching local clip when present and performs current-settings real-time synthesis when it is absent.
- Switching material or editing and reloading a Markdown file cannot cause an unrelated cached clip to play.
- If replacement generation fails, the previous active package remains usable.
- No generated audio leaves the local project output directory.

## Verification approach

Do not add or run an automated test suite unless requested. Review the implementation by checking the server job/status flow, exercising the browser controls with the existing local app, confirming foreground playback remains available during batch progress, and inspecting the active package and manifest on disk.
