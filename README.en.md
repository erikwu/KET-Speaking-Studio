# KET Speaking Studio

**Listen, practise, and give young learners more reasons to speak English.**

[中文](README.md) | English

I built this holiday side project with AI to help my child practise English and prepare for KET (Cambridge A2 Key). It runs on your Mac and opens in a browser, with sentence-by-sentence listening, dialogue practice, and mock speaking exams with local AI transcription and feedback.

A few small gamification touches—progress, per-answer scores, and a celebration sound for full marks—make “let’s try again” a little more inviting. Parents, learners, and fellow AI tinkerers are welcome to try it and share ideas.

[Quick start](#quick-start-minimal-install) · [Practice materials](#where-to-get-practice-materials) · [Everyday practice](#how-to-practise) · [Troubleshooting](#troubleshooting)

## What you can do

- **Listen and repeat:** play questions and answers at your own pace. Chinese translations appear below the English when included in your material.
- **Practise dialogues:** organise material into Part 1 / Phase 1, Part 1 / Phase 2, and Part 2, retaining speaker roles, context, and available pictures.
- **Try mock exams:** listen to prompts, record answers, and review transcripts and feedback on relevance, completeness, grammar, and vocabulary.
- **Review and stay motivated:** track progress, hints, and scores; try answering again; toggle full-mark celebration sounds; save results as a PDF.
- **Practise locally:** speech recognition and scoring run on your Mac. Once setup and resource preparation are complete, practice works offline without a cloud AI API key.

AI scores are practice feedback, not official Cambridge scores. They do not assess pronunciation or accent. The app and installer currently use mainly Chinese labels; this guide includes the labels you will see.

## Choose your installation

You need an **Apple Silicon Mac (M-series chip)**. The installer prepares the required software. Initial setup and update checks need an internet connection.

| | Minimal: recommended if you have a resource pack | Full: create your own audio and pictures |
| --- | --- | --- |
| Play sentences and view pictures | Use audio and pictures from imported packs | Generate locally or import packs |
| Mock exams, transcription, AI scoring | Included | Included |
| Custom voices, live speech generation, picture generation | No generation; existing resources remain usable | Included |
| Model downloads | About 3.9 GB | About 33 GiB |
| Suggested free disk space | About 10 GiB | At least 40 GiB |

These figures describe downloads and disk space, **not RAM requirements**. Runtime memory use and speed depend on your Mac and the task. Minimal Install includes the mock-exam models; it is not a model-free mode. For playback alone, see [playback without AI models](#play-existing-audio-without-installing-ai-models).

## Quick start: Minimal Install

### 1. Get the app and a resource pack

1. On the [GitHub project page](https://github.com/erikwu/KET-Speaking-Studio), choose **Code → Download ZIP**.
2. Unzip the project into a folder you intend to keep.
3. Download the [default practice pack](https://drive.google.com/file/d/1SbQ-aulyipVFaVSg_zly7SvpYDHMWtJb/view?usp=drive_link) (`.ketpack.zip`), or use your own pack. It contains practice material and pre-generated audio and is downloaded separately from the source code. The installer downloads the models.

### 2. Run the installer

Double-click [`install.command`](install.command), type **`2`**, and press Return to select **最小安装 (Minimal Install)**. Pressing Return without entering a number selects the default Full Install.

Follow the Terminal prompts. If Apple Command Line Tools opens an installation window, finish that installation, then return to Terminal and press Return. Homebrew setup may ask for your Mac administrator password. The first run downloads dependencies and models, so allow time; you can rerun the installer after an interrupted download.

When setup finishes, it opens [http://127.0.0.1:8788](http://127.0.0.1:8788) automatically. Keep the Terminal window running while you use the app.

### 3. Import and start practising

1. Click **导入资源包 (Import Resource Pack)** and select the `.ketpack.zip`. Do not unzip it; you do not need the original Mac’s file path.
2. Choose a practice section and click **朗读 (Read Aloud)**. Listen to a sentence, then say it yourself.
3. When ready, click **开始模拟考 (Start Mock Exam)**, allow microphone access, and follow the prompts.

Minimal Install defaults to **离线优先 (Offline First)**. The file/audio settings and voice/tone settings start collapsed. Changing voice tags does not alter pre-generated audio.

## Where to get practice materials

### Use an existing pack

Try the [default practice pack on Google Drive](https://drive.google.com/file/d/1SbQ-aulyipVFaVSg_zly7SvpYDHMWtJb/view?usp=drive_link). You can also click **下载默认材料 (Download Default Material)** in the material panel, download the file, then click **导入资源包 (Import Resource Pack)**. Hover over the download link for instructions.

Alternatively, import a pack exported from another Mac with Full Install, or ask a family member or teacher who uses the app to share one. A pack contains Markdown questions, complete audio, and any pictures already generated. It does not contain AI models.

A successful import replaces the active audio pack; a failed validation leaves the previous resources intact. Keep your exported packs if you want to switch between sets of material later.

### Make your own pack

You can ask AI to draft new Markdown questions using the format below, then check that the content suits your child’s level. If you need help, use the **question-mark help icon** in the panel to find me on [LinkedIn](https://www.linkedin.com/in/erik-wu-pmp-csm-15226412/); hover for a short tip, or click the icon to open LinkedIn. AI-generated text still needs audio generation before it can become a playable pack for Minimal Install.

On a Mac with **`1` — 完整安装 (Full Install)**:

1. Prepare a `.md` question file. Expand **读取文件与离线语音 (Read File & Offline Audio)**, enter its full local path, and click **读取文件 (Read File)**.
2. Click **为当前材料生产默认缓存 (Generate Default Audio Cache)** and wait for all audio to finish. Generate Part 2 pictures if wanted.
3. Click **下载离线资源包 (Download Offline Resource Pack)** and copy the exported `.ketpack.zip` to your Minimal Install Mac.

File paths often change between computers. Resource packs carry the material and matching audio together so you do not have to reconnect them manually.

### Use your own Markdown questions

This small example is suitable for checking file import and sentence practice. Save it as a UTF-8 `.md` file, with each spoken line on its own line:

```markdown
# Part 1 / Phase 1
Q: What is your name?（你叫什么名字？）
A: My name is Alex.（我叫 Alex。）

# Part 1 / Phase 2
Q: What do you like doing after school?（放学后你喜欢做什么？）
A: I like reading books.（我喜欢看书。）

# Part 2
1. Situation: Choosing an activity
A: Shall we play football?（我们踢足球好吗？）
B: I'd like to read a book.（我想读一本书。）
A: OK, let's read together.（好的，我们一起读吧。）
```

Bold Q/A/B labels, fullwidth colons, lists, and topic subheadings are supported. More examples and rules are in the [material format reference (Chinese)](speech/README.md#支持的-markdown-结构). Minimal Install can read the text, but Markdown alone **does not produce audio**; you need a matching offline resource pack.

Mock exams require at least **8 question groups in Phase 1**, **8 in Phase 2**, and **3 valid Part 2 scenarios**. Each Part 2 scenario must begin with three A/B/A turns, each with a Chinese translation for the exam prompts. The small example above is not enough to start a mock exam.

## How to practise

### Listen first, then speak

Import material → choose a section → play a sentence → repeat it or try your own answer. Replay as often as you like; you do not need to finish the whole set at once.

### Take a mock exam and review your answers

- Each session randomly selects 8 Phase 1 questions, 8 Phase 2 questions, and 3 Part 2 scenarios, with a shuffled order.
- Part 1 plays the question without showing its English text. Part 2 randomly assigns the opening turn to the learner or the computer.
- After recording, review the transcript and four feedback dimensions, each scored 0–5 for a total of 20. Viewing reference answers counts as using a hint.
- The first successfully scored answer counts toward the session result. Later practice answers do not replace that score.
- Open the results panel and click **保存为 PDF (Save as PDF)**, then choose Save as PDF in the system print dialog.

Refreshing or closing the page, or switching material, clears the session results. Save them before leaving. Celebration sounds can be disabled in the exam or results panel.

## Start again, stop, and update

**Next time:** double-click `install.command` and choose **`2`** again. Complete model downloads are reused. Alternatively, open Terminal in the project folder and run:

```sh
npm run start:tts
```

Then open [http://127.0.0.1:8788](http://127.0.0.1:8788). **To stop:** press **Control-C** in the Terminal window running the service.

**To update:** finish your mock exam and save the results, then click **检查更新 (Check for Updates) → 更新并重启 (Update & Restart)**. The button shows checking, installing, restarting, and recovery stages. The page refreshes when the service returns. The current version appears beside the app name.

Updates preserve models, resource packs, and browser settings. Minimal Install stays minimal. Start the app through the installer or the command above so the supervising process can restart the service.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No questions on first launch | Click Import Resource Pack. A fresh installation does not try to read anyone’s private file path. |
| Markdown file not found | Enter a valid full path on this Mac. Download iCloud files locally first, or import a resource pack when moving between Macs. |
| Questions appear but audio is missing | Minimal Install does not generate speech. Import a pack containing all audio for that material. |
| Start Mock Exam is disabled | Check the message near the button. Ensure the exam models are installed and all three sections contain enough valid questions. |
| Recording does not work | Allow microphone access in the browser and macOS privacy settings, check the input device, and retry. |
| Scoring fails or a transcript is inaccurate | Review the transcript, retry scoring or record again as prompted. Speak clearly near the microphone in a quiet room. |
| The page does not open | Check that the startup Terminal is still running and use the address it prints; the default port is 8788. |
| Installation was interrupted | Resolve the reported issue and rerun `install.command` with the same profile. Complete models are not downloaded again. |
| Updating is blocked | Wait for recording, scoring, generation, or resource tasks to finish. If local code changes are reported, back them up and resolve them first. |

### Play existing audio without installing AI models

On a Mac with **Node.js 22+** and the built-in `zip` / `unzip` tools, run `npm run start:tts` from the project folder and import a resource pack. Do not run `install.command` for this mode. It installs no models and supports existing audio and pictures, but **not AI mock exams, speech generation, or picture generation**.

## Where your data lives

- The service listens only on `127.0.0.1` on your Mac. Practice material, speech recognition, scoring, and picture processing are not sent to cloud inference services. Installation downloads and GitHub updates use the internet.
- Models live in `models/`; practice resources live in `outputs/speech-practice/`. Your browser remembers the last successfully loaded material and your settings.
- Temporary exam recording files are deleted after transcription processing. Session recordings, transcripts, and results stay in page memory and are cleared on refresh.
- **Scoring failure diagnostics persist locally:** `outputs/speech-practice/exam-diagnostics.jsonl` may contain questions, reference answers, learner transcripts, and model output, but not recordings. Remove personal information before sharing diagnostics in an issue.

## More information

- [Detailed practice, model, and material reference (Chinese)](speech/README.md)
- [Optional Visual Generation Studio (Chinese)](web/README.md): a separate image and image-to-video tool on port 8787. It is not required for KET practice. Video models and their environment need separate setup and are not included in the installation space estimates above.
- [Report a problem or suggest an idea](https://github.com/erikwu/KET-Speaking-Studio/issues)

<details>
<summary>For developers: services, updates, and releases</summary>

- KET service: `npm run start:tts` (8788). Optional visual studio: `npm start` (8787). Run and stop them in separate terminals. Running `speech/server.ts` directly does not provide supervised restarts.
- Git updates require a clean `main` branch that can fast-forward. ZIP updates verify the original files against GitHub history and stop if their version cannot be identified or code has changed. Updates need Git and network access.
- Update backups and recovery records live in `outputs/app-updates/`. Startup or capability-check failures trigger a rollback attempt; interrupted updates recover through the normal startup command. Recovery conflicts preserve backups and request manual action. Dependency changes may require rerunning the installer.
- `package.json` is the version source. Before releasing code, run `npm run release:patch` (or `release:minor` / `release:major`), then `npm run check:version -- origin/main` and `npm run test:resource-bundles`. Commit and push, and confirm the GitHub Version policy check passes. These commands do not commit or create Git tags automatically.
- Documentation-only or test-only changes may keep the current version. Application code updates must increase it; installation updates reject downgrades.
- Keep models, personal material, and generated output out of Git. See the detailed references for model inventories and licenses.

</details>

## Author and license

Built by [Erik](https://www.linkedin.com/in/erik-wu-pmp-csm-15226412/). Contributions, feedback, and ideas for getting children speaking are welcome.

Project code is licensed under [Apache-2.0](LICENSE). Downloaded models have separate licenses; see the [model license notes (Chinese)](speech/README.md), especially the terms for commercial use of image models.
