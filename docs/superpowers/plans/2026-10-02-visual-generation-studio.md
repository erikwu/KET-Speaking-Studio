# Visual Generation Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Wan 2.2 I2V A14B MLX Q8 image-to-video generation to the existing 8787 Qwen Image Studio and rename the unified app to “视觉生成工作室”.

**Architecture:** Keep one vanilla browser UI and one loopback-only Node server. Add a video-specific API route and Wan runner while reusing the existing job registry, progress polling, cancellation, and single-active-job lock. Keep the image API and Qwen execution path intact.

**Tech Stack:** Node.js 22 `node:http` server with JavaScript-compatible `.ts` files and Node type stripping, vanilla HTML/CSS/JavaScript, Python 3.13, MLX 0.32.3, and the installed `mlx-video` package in `.venv-wan22-mlx`.

**Spec:** `docs/superpowers/specs/2026-10-02-visual-generation-studio-design.md`

## Global Constraints

- The service listens only on `127.0.0.1` and remains on port 8787, started with `npm start`.
- Image and video inference share one active-job lock; do not run both models concurrently.
- Video uses `models/Wan2.2-I2V-A14B-MLX-Q8` and `.venv-wan22-mlx/bin/python`; retain the existing `models/Wan2.2-TI2V-5B-MLX-Q8` directory untouched.
- Video input supports one PNG, JPEG, or WebP image up to 24 MB, plus a required prompt.
- Video defaults are 1280×704, 41 frames, 40 steps, guidance scale 3.5 applied to both experts, and fixed 16 fps; frame options are 41, 81, and 121.
- Video width and height are multiples of 16; the frame count is 4n+1.
- Use aggressive VAE tiling; the A14B Q8 weights occupy about 42.7 GB and may swap heavily on 64 GB unified memory.
- Video prompt and output remain local under `outputs/web-ui/<job-id>/`.
- Preserve existing Qwen Image 2.1 controls, output formats, and `POST /api/generate` behavior.
- Do not add or run automated tests unless requested; use the manual verification steps below.

## File Map

- `web/server.ts`: video readiness, validation, job launch and lifecycle, shared job status, and MP4 delivery.
- `web/app.ts`: mode switching, independent readiness, video upload/submission, shared job polling/cancellation, and media-specific results.
- `web/index.html` and `web/styles.css`: accessible two-mode form, video player, studio identity, and responsive layout.
- `package.json`, `README.md`, and `web/README.md`: package identity and launch/use documentation.
- `outputs/web-ui/<job-id>/`: runtime-only prompt, uploaded image, and generated image/video; do not modify generated files during implementation.

## Review Focus

- Missing either A14B expert weight, other required Wan files, or runner must disable video independently while leaving a ready image mode usable. (Task 1, Step 2; Task 2, Step 3.)
- A spoofed MIME type, unsupported image signature, or image over 24 MB must be rejected before saving or spawning. (Task 1, Step 3; Task 2, Step 4.)
- Invalid dimensions, frame count, prompt, steps, guidance, or seed must receive a clear validation error. (Task 1, Step 3; Task 2, Step 5.)
- A second request during either image or video inference must receive HTTP 409 and must not start another process. (Task 1, Step 5; Task 5, Step 2.)
- A missing runner, failed child process, cancellation, or unavailable output must release the shared lock and render a recoverable error state. (Task 1, Steps 4–6; Task 3, Steps 2–4.)

---

### Task 1: Add Wan readiness and video jobs to the local server

**Files:**
- Modify: `web/server.ts`

**Interfaces:**
- Consumes: Existing `ReferenceImageInput`, JSON size limits, `jobs`, `activeJobId`, `publicJob`, cancellation route, and image job lifecycle.
- Produces: `GET /api/config` retains its current top-level image fields and adds `video: { modelName, modelPath, modelReady, cliReady, defaults: { width, height, frameOptions, numFrames, steps, guideScale, fps } }`.
- Produces: `POST /api/video/generate` accepts `{ prompt: string, negativePrompt?: string, image: ReferenceImageInput, seed?: number | null, steps: number, width: number, height: number, numFrames: 41 | 81 | 121, guideScale: number }` and returns the common public job shape with `mediaType: "video"`, `videoUrl`, and `videoDownloadUrl` when complete. Image jobs publish `mediaType: "image"` and keep their current image URL fields.
- Produces: `GET /api/jobs/:id/video` serves the completed MP4 inline; `?download=1` serves it as an attachment. Existing `/image` and `/cancel` routes remain compatible.

- [ ] **Step 1: Add video model and runner constants** in `web/server.ts`: resolve the model directory to `models/Wan2.2-I2V-A14B-MLX-Q8` and the runner to `.venv-wan22-mlx/bin/python`; readiness requires `config.json`, both `high_noise_model.safetensors` and `low_noise_model.safetensors`, `t5_encoder.safetensors`, `vae.safetensors`, and the Python executable. Keep the old 5B model directory untouched.
- [ ] **Step 2: Extend `/api/config` without changing the image response fields.** Add the video readiness and exact approved defaults. Confirm the image readiness calculation remains independent.
- [ ] **Step 3: Define and validate `VideoGenerateInput`.** Require a non-empty prompt up to 10,000 characters; optional negative prompt up to 5,000; one supported image with matching PNG/JPEG/WebP signature and at most 24 MB; dimensions from 256 to 4096 divisible by 16; `numFrames` exactly 41, 81, or 121; steps 1–100; finite guidance scale from 0 to 20; and optional integer seed from 0 through 4,294,967,295. Use the existing JSON request-size limit.
- [ ] **Step 4: Add `launchVideoJob(input)` and common child-process lifecycle handling.** Create a random job directory under `outputs/web-ui/`, save `prompt.txt` and the decoded input image, and set `result.mp4` as the expected output. Spawn `.venv-wan22-mlx/bin/python` with `-m mlx_video.models.wan_2.generate`, `--model-dir`, `--image`, `--prompt`, `--width`, `--height`, `--num-frames`, `--steps`, `--guide-scale <value>,<value>`, `--tiling aggressive`, `--seed`, and `--output-path` arguments (never shell-interpolate). Append a non-empty `--negative-prompt` pair only when supplied so the model's configured default remains active otherwise. Generate a 32-bit unsigned random seed when input is blank and expose it in status. Reuse an idempotent finalizer from child `error` and `close` events: clear the shared active-job lock once, mark cancellation, require exit code 0 plus an existing output before completion, and report a bounded log tail on failure. Parse Wan's `tqdm` `current/total` progress from stdout/stderr into the shared progress field.
- [ ] **Step 5: Route video submissions through the shared lock and job registry.** Add `POST /api/video/generate`, reserve `activeJobId` during request validation as the image route does, return 503 for missing model/runner, 409 for an occupied slot, 202 with job state on success, and always release the preparing lock on validation or launch failure. Add `mediaType` to `Job` and `publicJob` without changing image payload fields.
- [ ] **Step 6: Add MP4 output serving and shared result metadata.** Extend job routing with `/video`; serve `video/mp4` inline or with attachment disposition for `?download=1`, and support HTTP byte ranges with `206`, `Content-Range`, and `Accept-Ranges` so native playback seeking works. Return 409 until complete and 404 for a missing output. Keep existing image content types, route, and filenames unchanged.
- [ ] **Step 7: Manually inspect readiness and validation through the local server.** Start the server on a temporary local port and inspect `/api/config`; confirm the reported video readiness matches both A14B expert files, other required model files, and runner, and image fields retain their current shape. Submit malformed JSON, unsupported/mismatched image data, an image over 24 MB, invalid frame count, dimensions not divisible by 16, empty/oversized prompt, invalid steps, guidance, and seed; confirm clear 4xx errors and that rejected requests create no job folder and spawn no process. This is a manual check, not an automated test.
- [ ] **Step 8: Commit the server task** with a message such as `feat: add local Wan video generation API`.

### Task 2: Add the mode switch and video-generation form

**Files:**
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/app.ts`

**Interfaces:**
- Consumes: The existing image form and the `video` configuration object returned by `/api/config`.
- Produces: Accessible “图像” and “图生视频” mode controls; the selected panel is visible and the other hidden. Image mode remains selected on initial load.
- Produces: `POST /api/video/generate` requests using the Task 1 payload and the existing browser FileReader upload pattern.

- [ ] **Step 1: Add the mode navigation and video form markup** in `web/index.html`. Use two native mode buttons with `aria-pressed` state and labelled form panels, so keyboard users can switch modes without custom tab keyboard handling. Include one-image upload/preview/remove, required prompt, width, height, frame dropdown (41/81/121; select 41), steps (40), guidance scale (3.5 applied to both experts), optional seed, optional negative prompt, and a fixed 16 fps note.
- [ ] **Step 2: Add responsive video-form styles** in `web/styles.css`, reusing existing field, upload, parameter-grid, and button tokens. Make the mode switch, upload state, and controls work at the existing mobile breakpoint.
- [ ] **Step 3: Add mode state and readiness handling** in `web/app.ts`. Preserve the current image readiness flow; independently enable or disable video generation using `config.video.modelReady` and `config.video.cliReady`. Switching modes must not reset either form.
- [ ] **Step 4: Implement video image selection** with PNG/JPEG/WebP MIME checks, 24 MB limit, drag/drop, local preview, and remove action. Reuse the existing object-URL cleanup pattern and report invalid files in the video form's alert region.
- [ ] **Step 5: Implement video form validation and payload creation.** Mirror server constraints for prompt, image, dimensions, frame option, steps, guidance, and seed. Read the image as a data URL and submit the exact Task 1 payload to `/api/video/generate`.
- [ ] **Step 6: Manually inspect both modes in the browser.** Confirm initial image mode, mode switching, preserved image inputs, independent readiness messages, video file preview/remove, and client-side rejection of unsupported/oversized files and invalid prompt, dimension, frame, steps, guidance, or seed values.
- [ ] **Step 7: Commit the form task** with a message such as `feat: add video generation mode controls`.

### Task 3: Integrate shared job progress, cancellation, and video results

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.ts`
- Modify: `web/styles.css`
- Modify: `web/server.ts` only if job metadata needs a small interface adjustment discovered during integration.

**Interfaces:**
- Consumes: Task 1 job fields `mediaType`, `videoUrl`, `videoDownloadUrl`, `seed`, state, progress, message, and log tail.
- Produces: One shared active job UI; image jobs render the existing image result; video jobs render a native `<video controls playsinline preload="metadata">` and MP4 download.

- [ ] **Step 1: Extend the shared `JobStatus` type** in `web/app.ts` with `mediaType`, `videoUrl`, and `videoDownloadUrl`; retain the existing image URL fields.
- [ ] **Step 2: Adapt busy, cancel, and poll behavior** so both forms share `currentJobId`, progress, and cancellation. Disable both submit buttons and mode switching while a job is active; keep the originating mode selected after completion, failure, or cancellation.
- [ ] **Step 3: Render results by media type.** Keep the existing image preview and download untouched. For videos, set the player source to `videoUrl`, set the download action to `videoDownloadUrl`, show MP4 details and the chosen seed, and use a video-specific accessible label.
- [ ] **Step 4: Unify terminal states and output copy.** Generalize generator error details so they are not mflux-specific; handle failed, cancelled, missing output, and connection-loss states; clear the inactive media element source when replacing a result so stale playback cannot continue. A browser connection loss must show a retryable message without assuming the server-side process stopped or releasing its lock.
- [ ] **Step 5: Manually inspect task transitions.** Confirm progress and cancel controls affect either generation mode, mode switching remains locked while active, completed image jobs still display images, and a completed video status uses the MP4 player/download route. Check player seeking through the video route's byte-range support.
- [ ] **Step 6: Commit the job/result task** with a message such as `feat: preview and download generated videos`.

### Task 4: Rename the studio and update usage documentation

**Files:**
- Modify: `web/index.html`
- Modify: `web/server.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `web/README.md`

**Interfaces:**
- Consumes: The integrated two-mode UI and API from Tasks 1–3.
- Produces: Product title, browser title, startup log, package metadata, and terminal-window documentation consistently name “视觉生成工作室”; `npm start` and port 8787 remain unchanged.

- [ ] **Step 1: Replace the visible and browser-facing Qwen-only studio name** in `web/index.html` with “视觉生成工作室”; retain Qwen 2.1 as the image-mode model label.
- [ ] **Step 2: Update the 8787 startup message** in `web/server.ts` and rename the package metadata in `package.json` to `visual-generation-studio`; preserve `start` and `start:tts` scripts.
- [ ] **Step 3: Update root and web documentation** to describe the combined image/video modes, Wan I2V A14B model path and isolated runner, 41/81/121 frame selector, 16 fps output, local output directory, readiness behavior, retained 5B model, and unchanged 8787 launch steps.
- [ ] **Step 4: Review all user-facing app references** with a targeted text search; keep Qwen references where they describe the image model, and remove old app-name references from the 8787 product identity.
- [ ] **Step 5: Commit the naming and documentation task** with a message such as `docs: rename local studio and document video mode`.

### Task 5: Switch the video model to Wan 2.2 I2V A14B MLX Q8

**Files:**
- Modify: `web/server.ts`
- Modify: `web/app.ts`
- Modify: `web/index.html`
- Modify: `README.md`
- Modify: `web/README.md`
- Modify: `docs/superpowers/specs/2026-10-02-visual-generation-studio-design.md`
- Modify: this plan

**Interfaces:**
- Consumes: The existing image-to-video form and Wan runner; the user-approved Hugging Face repository `Anes1032/Wan2.2-I2V-A14B-mlx-q8`.
- Produces: The A14B Q8 model as the active video backend, model-specific readiness checks and defaults, and an untouched prior TI2V-5B model directory.

- [ ] **Step 1: Download the A14B I2V Q8 weights** into `models/Wan2.2-I2V-A14B-MLX-Q8`; do not overwrite or delete the existing 5B directory.
- [ ] **Step 2: Update backend readiness and launch arguments.** Check both noise experts, config, T5 encoder, and VAE. Pass the same UI guidance value to both experts and enable aggressive VAE tiling.
- [ ] **Step 3: Update model-specific UI defaults and output details.** Use 40 steps, guidance 3.5, 16 fps, and 16-pixel dimension alignment. Keep the 41/81/121 frame selector and calculate its displayed duration from 16 fps.
- [ ] **Step 4: Update the approved spec, plan, and usage docs** with the I2V A14B path, weight size and memory note, parameters, 16 fps, and retained 5B directory.
- [ ] **Step 5: Manually verify `/api/config`, readiness, video defaults and launch metadata;** do not run actual inference if the local environment cannot expose Metal. Do not add or run automated tests.
- [ ] **Step 6: Commit this model switch** with a message such as `feat: switch video studio to Wan I2V A14B Q8`.

### Task 6: Manual end-to-end review

**Files:**
- No new files.

**Interfaces:**
- Consumes: The full app produced by Tasks 1–4.
- Produces: A manually verified 8787 experience and a clean working-tree review; do not claim video generation was verified unless a real input image completed successfully.

- [ ] **Step 1: Start the app with `npm start`** and open `http://127.0.0.1:8787`; confirm page and browser titles show “视觉生成工作室” and the service remains loopback-only.
- [ ] **Step 2: Check the existing image flow's readiness and controls.** Confirm Qwen model status is independent from Wan readiness and inspect existing image-mode controls and available output formats.
- [ ] **Step 3: Check video readiness and parameter constraints.** Confirm 41 is the selected frame count, 81 and 121 are selectable, default dimensions/steps/guidance are correct, and invalid file/settings values are rejected before submission.
- [ ] **Step 4: If a suitable local image is available, submit one video job.** While it runs, send one additional video submission and (if the image model is ready) one image submission; confirm each receives HTTP 409 and does not start another child process. Confirm progress updates, cancellation releases the shared lock for the next job, and a completed job plays, seeks, and downloads as MP4 under its local job folder.
- [ ] **Step 5: Inspect the final diff and Git status.** Confirm only the planned app, docs, package metadata, and generated output exclusions are present; do not add or run automated tests unless requested.
- [ ] **Step 6: Complete a final code review** for path containment, argument-array process launch, independent readiness, bounded upload handling, response MIME/disposition, and preservation of the existing image API.
