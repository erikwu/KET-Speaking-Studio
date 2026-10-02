# Visual Generation Studio Design

## Goal

Combine the existing local Qwen image workflow and the installed Wan 2.2 TI2V-5B image-to-video workflow in the current 8787 web app, and rename that app to “视觉生成工作室”. The existing 8787 launch command and loopback-only access remain in place.

## User-approved behavior

- The studio has two modes: “图像” and “图生视频”. It opens in image mode so current image-generation behavior remains familiar.
- Image mode retains the existing Qwen Image 2.1 controls and output behavior.
- Video mode requires one PNG, JPEG, or WebP input image and a prompt. It exposes width, height, frame count, inference steps, guidance scale, optional seed, and an optional negative prompt.
- Frame count is a dropdown with 41, 81, and 121 frames; 41 is selected by default. Output frame rate is fixed at 24 fps.
- Video defaults are 1280×704, 20 steps, and guidance scale 5.0. Video width and height must be divisible by 32; frame count must be 4n+1.
- A completed video appears in a native video player with playback controls and an MP4 download action.
- The product title, visible brand, startup message, and usage docs use “视觉生成工作室”. The service remains at `http://127.0.0.1:8787` and starts with `npm start`.
- The same Node server and shared job lifecycle handle both modes. Only one image or video job may run at a time because both models use unified memory.
- The uploaded image, prompt, and output stay in the local project under `outputs/web-ui/<job-id>/`.

## Existing system

`web/server.ts` serves the current static page, validates JSON/base64 reference images, launches `mflux-generate-qwen-2.1`, tracks a single active job, exposes progress and cancellation, and serves completed images. `web/app.ts` owns the image form, polling, and image result display. `web/index.html` and `web/styles.css` define the current responsive Image Studio UI.

The installed Wan model is `models/Wan2.2-TI2V-5B-MLX-Q8`. The isolated runner is `.venv-wan22-mlx/bin/python`; it runs `-m mlx_video.models.wan_2.generate` with `--model-dir`, `--image`, `--prompt`, dimensions, frames, steps, guidance, seed, and output path. The model outputs MP4 at 24 fps. Its CLI and Metal GPU availability have been verified on this Mac.

## Approaches

1. **Unified 8787 studio with mode-specific API routes (recommended and approved).** Keep one frontend and Node server, add a video-generation route and runner, and reuse the existing job map, polling, cancellation, and global single-job lock. This keeps the product and resource behavior coherent while leaving the current image-generation route intact.
2. **Separate video service.** Run video inference as a second server and connect it from the same page. This isolates process concerns but adds service lifecycle and API coordination, and makes shared GPU-memory arbitration harder.

## User experience

1. The header and page title identify the app as “视觉生成工作室”; the existing model badge and local-only indication remain.
2. A mode switch selects “图像” or “图生视频”. The image mode preserves the existing Qwen workflow.
3. Video mode shows a single-image upload area with preview, filename, remove action, and the existing 24 MB local-upload limit. It shows the prompt field and an advanced-parameters section.
4. Video parameters include width and height (default 1280×704), frame count (41/81/121, default 41), steps (default 20), guidance scale (default 5.0), optional seed, and optional negative prompt. Output fps is shown as fixed at 24.
5. Submitting starts a shared background job. The canvas shows load/sampling progress, supports cancellation, then displays the resulting MP4 in a native `<video controls>` element and offers download.
6. If the Wan files or isolated Python runner are unavailable, video mode shows the specific readiness issue and disables generation. Existing image readiness is independent.
7. Layout remains usable on narrow screens; mode controls and labels remain keyboard accessible.

## Server and data flow

- Extend `/api/config` with independent image and video readiness details. Video readiness checks the Wan model files and `.venv-wan22-mlx/bin/python`.
- Keep `POST /api/generate` for image jobs and add `POST /api/video/generate`. Both submit to the same global active-job lock and shared job registry; reject an overlapping job with HTTP 409.
- Video requests use the existing bounded JSON upload pattern. Validate prompt length, image MIME/content and size, dimensions divisible by 32, an allowed 4n+1 frame count, steps, guidance, and optional integer seed. Derive all output paths server-side.
- Save the input image and prompt in the server-created job folder, then spawn the isolated Wan runner with argument arrays (no shell interpolation). Use the model path in the project and write `result.mp4` into that job folder.
- Keep common status and cancel routes. Add a video output route that serves `video/mp4` inline or as an attachment. Image result routes and content types remain unchanged.
- Parse progress from the Wan process output into the shared job progress field. On process failure, return a concise error plus a bounded log tail; on cancellation, mark the job cancelled and release the active-job lock.
- The service continues listening only on `127.0.0.1`; no image, prompt, or output is sent to a remote inference provider.

## Files in scope

- `web/server.ts`: video readiness, input validation, runner dispatch, shared job metadata, MP4 serving.
- `web/app.ts`: mode switching, video form/upload state, video submission/polling/result handling, readiness display.
- `web/index.html` and `web/styles.css`: studio name, mode-specific forms, responsive video preview and result states.
- `README.md`, `web/README.md`, and the 8787 startup log: rename and document the unified modes and video settings.
- `package.json`: rename the local package metadata to `visual-generation-studio`; preserve the existing `start` and `start:tts` scripts.

## Out of scope

- Changing the 8788 speaking practice service or the existing Qwen generation semantics.
- Pure text-to-video, Wan 2.2 A14B, LoRA selection, configurable fps, video history management, batch/queued generation, or concurrent model inference.
- Introducing a frontend framework, cloud services, or external model calls.
- Running automated tests unless requested. Verification will use manual startup/API/UI checks and the verified Wan CLI entry point.

## Acceptance criteria

- The 8787 page and startup documentation identify the app as “视觉生成工作室”.
- Users can switch between the existing Qwen image workflow and a Wan image-to-video workflow in one page.
- Video mode accepts an image and prompt, offers all approved settings, defaults to 41 frames / 20 steps / 1280×704 / guidance 5.0, and enforces the model's dimensions and frame constraints.
- Video readiness is reported independently from image readiness.
- Image and video jobs share progress, cancellation, and a single active-job lock.
- A completed MP4 can be previewed and downloaded from the result panel.
- Uploaded data and generated results remain under `outputs/web-ui/`; the service remains loopback-only.
- Existing image generation still launches through the same Qwen model and returns the same output formats.

## Verification approach

Do not add or run automated tests unless requested. Manually inspect startup and `/api/config`, confirm both readiness states, switch modes, check upload validation and video parameter validation, submit a video job when an input image is available, observe progress/cancellation, and confirm MP4 preview/download and the local output path. Also confirm image mode remains usable and inspect the final diff and Git status.
