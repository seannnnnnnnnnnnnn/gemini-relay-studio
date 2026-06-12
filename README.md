# Gemini Relay Studio

Gemini Relay Studio is a local AI video creation studio for teams that want to turn ideas, prompts, images and reference frames into trackable generation work. It connects to OneAPI / New API compatible gateways and keeps the production loop on the creator's machine: API keys stay local, assets stay local, projects stay editable.

The product is built for AI video operators, short drama creators, content teams and model gateway users who need a cleaner workflow than scattered prompt documents, browser tabs and one-off task IDs.

## Why It Matters

AI video production breaks down when prompts, reference images, model settings and generated assets are managed in separate places. Gemini Relay Studio brings those moving parts into one desktop workspace:

- **One workspace for text, image and video generation**: switch between creative tasks without losing project context.
- **Editable model and route settings**: use Gemini, Veo and compatible gateway models without being locked into fixed dropdowns.
- **Project-based history**: reload previous jobs, inspect generation parameters and continue editing instead of starting over.
- **Reference-image video workflow**: submit Veo-style video jobs with a first frame or external reference image.
- **Local-first storage**: API credentials, SQLite data and generated assets are stored locally, not bundled into the app or uploaded by default.
- **Desktop distribution**: ready-to-run macOS and Windows packages are generated from the same codebase.

## Product Highlights

### For Creators

Move faster from concept to output. Generate text, images and videos in one place, keep successful prompts attached to their results, and reuse generated assets as reference material.

### For Producers

Keep work organized by project. Every task stores model, route and generation parameters so outputs remain explainable after the team changes defaults or switches gateways.

### For Technical Operators

Use editable OneAPI / New API routes for text, image, video creation, native reference-image video submission and polling. Diagnostic reports redact local paths and saved keys before export.

## Download

Use the latest GitHub Release for desktop builds:

- **macOS Apple Silicon**: `Gemini-Relay-Studio-macOS-arm64-v0.2.1.zip`
- **macOS Intel**: `Gemini-Relay-Studio-macOS-x64-v0.2.1.zip`
- **Windows x64**: `Gemini-Relay-Studio-Windows-x64-v0.2.1.zip`

Unzip the package and launch the app. On first start, configure the API gateway in the API settings panel.

### macOS Installation

Gatekeeper-ready distribution requires an Apple Developer ID signature and Apple
notarization. When a release is marked as an ad-hoc signed build, unzip it, move
the app to `Applications`, then Control-click the app and choose **Open**. On
newer macOS versions, use **System Settings > Privacy & Security > Open Anyway**
if the first launch is blocked.

Release builds are verified with `codesign --verify --deep --strict`. Maintainers
can produce a fully notarized build by installing a `Developer ID Application`
certificate and setting `MAC_CODESIGN_IDENTITY` plus `APPLE_NOTARY_PROFILE`.

## Requirements

Desktop builds include Electron and do not require a separate Node.js install for normal use.

For source development or local packaging:

- Node.js 24+
- npm
- A OneAPI / New API compatible gateway key

## API Setup

Open **API Settings** and configure:

- OneAPI / New API base URL
- API key
- Text route
- Image route
- Video creation route
- Native reference-image video route
- Video polling routes
- Default text, image, vision and video models

The app normalizes common configuration mistakes automatically, including duplicated `/v1` path prefixes, console-page URLs pasted as API base URLs and keys pasted with `Bearer` or `Authorization:` prefixes.

## Local Data

Desktop builds store runtime data in the operating system user-data directory:

- macOS: `~/Library/Application Support/veo3-workflow/`
- Windows: `%APPDATA%\\veo3-workflow\\`

Stored locally:

- API configuration: `config/.env`
- SQLite database: `data/veo3.sqlite`
- Generated assets: `data/assets/`
- Runtime logs: `logs/desktop.log` and `logs/server.log`

The packaged app does not include local `.env`, databases, generated assets, memory notes or test-result folders.

## Source Development

Install dependencies:

```bash
npm install
```

Run the local server:

```bash
npm run start
```

Run the browser UI development build:

```bash
npm run web:dev
```

Package desktop builds:

```bash
npm run package:all
```

Platform-specific packaging:

```bash
npm run package:mac
npm run package:win
```

Output files:

- `dist/desktop/Gemini Relay Studio-darwin-arm64.zip`
- `dist/desktop/Gemini Relay Studio-darwin-x64.zip`
- `dist/desktop/Gemini Relay Studio-win32-x64.zip`

## Distribution Notes

Gemini Relay Studio is designed as a local creative operations tool. The release package is intentionally separated from local runtime data:

- `.env` is never packaged.
- Local databases and generated assets are excluded.
- Private memory files and test logs are excluded.
- macOS and Windows builds are uploaded as separate release assets.

## Positioning

Gemini Relay Studio is not another single prompt box. It is a production desk for AI video work: model settings, generation actions, result inspection and local assets live together, making it easier to build repeatable creative pipelines around Gemini, Veo and compatible API gateways.
