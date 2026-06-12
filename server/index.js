const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");

const { loadEnv, env, envInt, updateEnvFile } = require("./env");
const { createDatabase, createStore } = require("./db");
const { OneApiClient } = require("./oneapi");
const { id, parseDataUrl, dataUrlFromFile, imageDimensionsFromBuffer, imageDimensionsFromFile, saveRemoteOrDataAsset } = require("./storage");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.resolve(process.env.VEO3_CONFIG_DIR || ROOT);
loadEnv(CONFIG_DIR);
const ASSET_DOWNLOAD_TIMEOUT_FLOOR_MS = 600000;
const LEGACY_VIDEO_SAVE_RETRY_DELAYS = "0,5000,15000,30000";
const DEFAULT_VIDEO_SAVE_RETRY_DELAYS = "0,5000,15000,30000,60000";
const DEFAULT_PATHS = {
  chatPath: "/v1/chat/completions",
  imageChatPath: "/v1/chat/completions",
  videoCreatePath: "/v1/video/generations",
  videoOpenaiCreatePath: "/v1/videos",
  videoPollPaths: "/v1/video/generations/{id},/v1/videos/{id}"
};
const DEFAULT_MODELS = {
  textModel: "gemini-3.1-pro-preview",
  fastTextModel: "gemini-3.1-preview",
  visionModel: "gemini-3.1-pro-preview",
  imageModel: "gemini-3.1-flash-image-preview",
  videoModel: "veo-3.1-generate-001",
  videoFallbackModel: "veo-3.0-generate-001"
};

function effectiveAssetDownloadTimeoutMs() {
  return Math.max(envInt("ASSET_DOWNLOAD_TIMEOUT_MS", ASSET_DOWNLOAD_TIMEOUT_FLOOR_MS), ASSET_DOWNLOAD_TIMEOUT_FLOOR_MS);
}

function normalizeApiPath(raw, fallback) {
  let value = String(raw || "").trim();
  value = value.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim();
  if (!value) return fallback;
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      value = fallback;
    }
  }
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/+/g, "/");
  value = value.replace(/^\/v1beta\/v1\//, "/v1/");
  value = value.replace(/^\/v1\/v1\//, "/v1/");
  value = value.replace(/\/v1\/videos\/v1\/videos$/, "/v1/videos");
  value = value.replace(/\/+$/, "");
  return value || fallback;
}

function normalizePollPaths(raw) {
  const values = String(raw || DEFAULT_PATHS.videoPollPaths)
    .split(",")
    .map((entry) => normalizeApiPath(entry.trim(), ""))
    .filter(Boolean);
  const unique = values.filter((value, index, list) => list.indexOf(value) === index);
  return unique.length ? unique.join(",") : DEFAULT_PATHS.videoPollPaths;
}

function migrateLegacyRuntimeEnv() {
  const updates = {};
  if (effectiveAssetDownloadTimeoutMs() !== envInt("ASSET_DOWNLOAD_TIMEOUT_MS", 0)) {
    updates.ASSET_DOWNLOAD_TIMEOUT_MS = String(ASSET_DOWNLOAD_TIMEOUT_FLOOR_MS);
  }
  const retryDelays = env("VIDEO_SAVE_RETRY_DELAYS_MS", "").trim();
  if (!retryDelays || retryDelays === LEGACY_VIDEO_SAVE_RETRY_DELAYS) {
    updates.VIDEO_SAVE_RETRY_DELAYS_MS = DEFAULT_VIDEO_SAVE_RETRY_DELAYS;
  }
  const cleanBaseUrl = sanitizeConfigBaseUrl(env("ONEAPI_BASE_URL", ""));
  if (cleanBaseUrl && cleanBaseUrl !== env("ONEAPI_BASE_URL", "")) {
    updates.ONEAPI_BASE_URL = cleanBaseUrl;
  }
  const pathUpdates = {
    OPENAI_CHAT_PATH: normalizeApiPath(env("OPENAI_CHAT_PATH", DEFAULT_PATHS.chatPath), DEFAULT_PATHS.chatPath),
    IMAGE_CHAT_PATH: normalizeApiPath(env("IMAGE_CHAT_PATH", DEFAULT_PATHS.imageChatPath), DEFAULT_PATHS.imageChatPath),
    VIDEO_CREATE_PATH: normalizeApiPath(env("VIDEO_CREATE_PATH", DEFAULT_PATHS.videoCreatePath), DEFAULT_PATHS.videoCreatePath),
    VIDEO_OPENAI_CREATE_PATH: normalizeApiPath(env("VIDEO_OPENAI_CREATE_PATH", DEFAULT_PATHS.videoOpenaiCreatePath), DEFAULT_PATHS.videoOpenaiCreatePath),
    VIDEO_POLL_PATHS: normalizePollPaths(env("VIDEO_POLL_PATHS", DEFAULT_PATHS.videoPollPaths))
  };
  for (const [key, value] of Object.entries(pathUpdates)) {
    if (value && value !== env(key, "")) updates[key] = value;
  }
  if (Object.keys(updates).length) {
    updateEnvFile(CONFIG_DIR, updates);
    console.log(`[config.migrate] Updated runtime defaults: ${Object.keys(updates).join(", ")}`);
  }
}

migrateLegacyRuntimeEnv();

const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = path.resolve(process.env.VEO3_DATA_DIR || path.join(ROOT, "data"));
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const SERVER_LOG_FILE = process.env.VEO3_SERVER_LOG_FILE
  ? path.resolve(process.env.VEO3_SERVER_LOG_FILE)
  : "";
const PORT = envInt("PORT", 4310);
const HOST = env("HOST", "127.0.0.1");
const BODY_LIMIT_BYTES = 80 * 1024 * 1024;

fs.mkdirSync(ASSETS_DIR, { recursive: true });

const db = createDatabase(DATA_DIR);
const store = createStore(db);
const oneapi = new OneApiClient();
const activeJobs = new Set();

function clientForJob(job) {
  return new OneApiClient(job?.config?.routeOverrides || {});
}

function appendServerLog(scope, message, details = null) {
  if (!SERVER_LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SERVER_LOG_FILE), { recursive: true });
    const line = [
      new Date().toISOString(),
      `[${scope}]`,
      typeof message === "string" ? message : JSON.stringify(message),
      details ? JSON.stringify(details) : ""
    ].filter(Boolean).join(" ");
    fs.appendFileSync(SERVER_LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // Logging should never break runtime behavior.
  }
}

function tailServerLogLines(limit = 120) {
  if (!SERVER_LOG_FILE || !fs.existsSync(SERVER_LOG_FILE)) return [];
  const parsedLimit = Number.parseInt(String(limit), 10);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 10), 600) : 120;
  const content = fs.readFileSync(SERVER_LOG_FILE, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-safeLimit);
}

function diagnosticReport() {
  const settings = runtimeSettings();
  const jobs = store.listJobs(60);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    app: {
      name: "Gemini Relay Studio",
      version: "0.2.1",
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    runtime: {
      configured: oneapi.isConfigured(),
      baseUrl: oneapi.baseUrl,
      host: HOST,
      port: PORT,
      configDir: "[local-path-redacted]",
      dataDir: "[local-path-redacted]",
      logFile: SERVER_LOG_FILE ? "[local-path-redacted]" : "",
      activeJobs: Array.from(activeJobs)
    },
    settings: {
      connection: {
        ...settings.connection,
        keyPreview: settings.connection?.hasApiKey ? "[saved-key-redacted]" : ""
      },
      routes: settings.routes,
      models: settings.models
    },
    videoConfig: {
      createPath: env("VIDEO_CREATE_PATH", "/v1/video/generations"),
      openaiCreatePath: env("VIDEO_OPENAI_CREATE_PATH", "/v1/videos"),
      pollPaths: env("VIDEO_POLL_PATHS", "/v1/video/generations/{id},/v1/videos/{id}"),
      requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 120000),
      imageRequestTimeoutMs: envInt("IMAGE_REQUEST_TIMEOUT_MS", 300000),
      assetDownloadTimeoutMs: effectiveAssetDownloadTimeoutMs(),
      saveRetryDelaysMs: env("VIDEO_SAVE_RETRY_DELAYS_MS", DEFAULT_VIDEO_SAVE_RETRY_DELAYS)
    },
    recentJobs: jobs.map((job) => publicJob(job, { full: job.type === "video" })),
    recentVideoJobs: jobs.filter((job) => job.type === "video").slice(0, 20).map((job) => publicJob(job, { full: true })),
    recentAssets: store.listAssets(40).map(publicAsset),
    logs: tailServerLogLines(240)
  };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, error) {
  appendServerLog("http.error", `${status} ${error?.message || String(error)}`);
  sendJson(res, status, {
    ok: false,
    error: error?.message || String(error),
    details: error?.payload ? scrubDeep(error.payload) : undefined
  });
}

function sanitizeConfigApiKey(raw) {
  let key = String(raw || "").trim();
  key = key.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim();
  key = key.replace(/^authorization\s*:\s*/i, "").trim();
  key = key.replace(/^bearer\s+/i, "").trim();
  key = key.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim();
  return key;
}

function sanitizeConfigBaseUrl(raw) {
  let value = String(raw || "").trim();
  value = value.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    let pathname = (parsed.pathname || "").replace(/\/+$/, "");
    const lowerPath = pathname.toLowerCase();
    if (
      [
        "/panel",
        "/dashboard",
        "/console",
        "/login",
        "/settings",
        "/token",
        "/tokens",
        "/admin"
      ].some((entry) => lowerPath === entry || lowerPath.startsWith(`${entry}/`))
    ) {
      pathname = "";
    }
    if (pathname === "/v1" || pathname === "/v1beta") {
      pathname = "";
    }
    parsed.pathname = pathname || "";
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function safeStaticPath(baseDir, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const target = path.normalize(path.join(baseDir, decoded));
  const relative = path.relative(baseDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function serveFile(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
  });
  fs.createReadStream(filePath).pipe(res);
}

function modelCatalog() {
  return {
    text: [
      env("TEXT_MODEL", "gemini-3.1-pro-preview"),
      env("FAST_TEXT_MODEL", "gemini-3.1-preview"),
      "gemini-3.1-pro-preview",
      "gemini-3.1-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview"
    ].filter((value, index, list) => value && list.indexOf(value) === index),
    image: [
      env("IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview"
    ].filter((value, index, list) => value && list.indexOf(value) === index),
    video: [
      "veo-3.1-generate-001",
      env("VIDEO_MODEL", "veo-3.1-generate-001"),
      env("VIDEO_FAST_MODEL", "veo-3.1-fast-generate-preview"),
      "veo-3.0-generate-001",
      "veo-3.0-fast-generate-001",
      "veo-2.0-generate-001",
      "veo-3.1-generate-preview",
      "veo-3.1-fast-generate-preview",
      env("VIDEO_LITE_MODEL", "veo-3.1-lite-generate-preview"),
      "veo-3.1-lite-generate-preview"
    ].filter((value, index, list) => value && list.indexOf(value) === index)
  };
}

function runtimeSettings() {
  return {
    connection: {
      baseUrl: oneapi.baseUrl,
      configured: oneapi.isConfigured(),
      hasApiKey: Boolean(oneapi.apiKey),
      keyPreview: oneapi.apiKey ? `${oneapi.apiKey.slice(0, 6)}...${oneapi.apiKey.slice(-4)}` : ""
    },
    models: {
      textModel: env("TEXT_MODEL", DEFAULT_MODELS.textModel),
      fastTextModel: env("FAST_TEXT_MODEL", DEFAULT_MODELS.fastTextModel),
      visionModel: env("VISION_MODEL", DEFAULT_MODELS.visionModel),
      imageModel: env("IMAGE_MODEL", DEFAULT_MODELS.imageModel),
      videoModel: env("VIDEO_MODEL", DEFAULT_MODELS.videoModel),
      videoFallbackModel: env("VIDEO_FALLBACK_MODEL", DEFAULT_MODELS.videoFallbackModel)
    },
    routes: {
      chatPath: normalizeApiPath(env("OPENAI_CHAT_PATH", DEFAULT_PATHS.chatPath), DEFAULT_PATHS.chatPath),
      imageChatPath: normalizeApiPath(env("IMAGE_CHAT_PATH", DEFAULT_PATHS.imageChatPath), DEFAULT_PATHS.imageChatPath),
      videoCreatePath: normalizeApiPath(env("VIDEO_CREATE_PATH", DEFAULT_PATHS.videoCreatePath), DEFAULT_PATHS.videoCreatePath),
      videoOpenaiCreatePath: normalizeApiPath(env("VIDEO_OPENAI_CREATE_PATH", DEFAULT_PATHS.videoOpenaiCreatePath), DEFAULT_PATHS.videoOpenaiCreatePath),
      videoPollPaths: normalizePollPaths(env("VIDEO_POLL_PATHS", DEFAULT_PATHS.videoPollPaths))
    }
  };
}

function defaultProjectConfig() {
  const settings = runtimeSettings();
  return {
    appModule: "",
    modulePrompt: "",
    moduleOutput: "",
    moduleResultAssetId: "",
    moduleResultJobId: "",
    moduleFileName: "",
    textSystemPrompt: "",
    textTemperature: "0.72",
    textMaxTokens: "",
    imageNegativePrompt: "",
    videoReferenceUrl: "",
    videoReferenceAssetId: "",
    videoReferenceWidth: "",
    videoReferenceHeight: "",
    storySeed: "",
    storyText: "",
    storyboardText: "",
    assetCharacterCount: "3",
    assetSceneCount: "5",
    assetPlan: { characters: [], scenes: [] },
    storyGenre: "",
    storyTone: "",
    totalDuration: "48",
    videoStyle: "",
    storyboardShotCount: "6",
    storyboardAspectRatio: "16:9",
    storyboardDuration: "8",
    frameImageSize: "2K",
    aspectRatio: "16:9",
    resolution: "720p",
    duration: "8",
    imageSize: "2K",
    referenceMode: "native_multipart",
    ...settings.models,
    ...settings.routes
  };
}

function effectiveProjectConfig(projectId) {
  const project = projectId ? store.getProject(projectId) : null;
  return {
    ...defaultProjectConfig(),
    ...(project?.config || {})
  };
}

function cleanProjectConfig(raw = {}) {
  const base = defaultProjectConfig();
  const out = {};
  for (const [key, fallback] of Object.entries(base)) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") continue;
    if (key === "assetPlan") {
      out[key] = scrubDeep(raw[key]);
      continue;
    }
    out[key] = String(raw[key]).trim();
  }
  for (const key of ["chatPath", "imageChatPath", "videoCreatePath", "videoOpenaiCreatePath"]) {
    if (out[key]) out[key] = normalizeApiPath(out[key], base[key]);
  }
  if (out.videoPollPaths) out.videoPollPaths = normalizePollPaths(out.videoPollPaths);
  return out;
}

function routeOverridesFromConfig(config = {}) {
  return {
    chatPath: config.chatPath,
    imageChatPath: config.imageChatPath,
    videoCreatePath: config.videoCreatePath,
    videoOpenaiCreatePath: config.videoOpenaiCreatePath,
    videoPollPaths: config.videoPollPaths
  };
}

function cleanAssetMetadata(raw = {}) {
  const allowedTypes = new Set(["character", "scene", "prop", "keyframe", "video", "general"]);
  const metadata = {
    ...(raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {})
  };
  const libraryType = textField(raw.libraryType || raw.library_type || metadata.libraryType, 80);
  if (libraryType) metadata.libraryType = allowedTypes.has(libraryType) ? libraryType : "general";
  const title = textField(raw.title || raw.libraryTitle || raw.library_title || metadata.title, 200);
  if (title) metadata.title = title;
  const parentAssetId = textField(raw.parentAssetId || raw.parent_asset_id || metadata.parentAssetId, 120);
  if (parentAssetId) metadata.parentAssetId = parentAssetId;
  const shotId = textField(raw.shotId || raw.shot_id || metadata.shotId, 120);
  if (shotId) metadata.shotId = shotId;
  const role = textField(raw.role || metadata.role, 120);
  if (role) metadata.role = role;
  return scrubDeep(metadata);
}

function cleanReferenceAssetIds(raw = [], projectId = "") {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const unique = [];
  for (const value of values) {
    const idValue = textField(value, 120);
    if (!idValue || unique.includes(idValue)) continue;
    const asset = store.getAsset(idValue);
    if (!asset) continue;
    if (!asset.mime.startsWith("image/")) continue;
    if (projectId && asset.projectId !== projectId) continue;
    unique.push(idValue);
    if (unique.length >= 3) break;
  }
  return unique;
}

function imageMetadataFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return {};
  return {
    width: dimensions.width,
    height: dimensions.height,
    orientation: dimensions.width > dimensions.height ? "landscape" : dimensions.height > dimensions.width ? "portrait" : "square"
  };
}

function scrubString(value, maxLength = 4000) {
  let text = String(value ?? "");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  text = text.replace(/sk-[A-Za-z0-9._-]{8,}/gi, "sk-[redacted]");
  text = text.replace(/data:([^;,]+);base64,[A-Za-z0-9+/=]+/g, "data:$1;base64,[redacted]");
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}...[truncated]`;
  return text;
}

function scrubDeep(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => scrubDeep(item, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/api[_-]?key|authorization|token|secret|password/i.test(key)) {
      out[key] = "[redacted]";
    } else if (key === "path") {
      out[key] = "[local-path-redacted]";
    } else {
      out[key] = scrubDeep(entry, depth + 1);
    }
  }
  return out;
}

function publicAsset(asset) {
  if (!asset) return null;
  const metadata = { ...(asset.metadata || {}) };
  if (asset.kind === "image" && (!metadata.width || !metadata.height)) {
    Object.assign(metadata, imageMetadataFromDimensions(imageDimensionsFromFile(asset.path)));
  }
  delete metadata.originalUrl;
  return {
    id: asset.id,
    kind: asset.kind,
    mime: asset.mime,
    filename: asset.filename,
    source: scrubString(asset.source || "", 600),
    prompt: scrubString(asset.prompt || "", 1200),
    model: asset.model,
    jobId: asset.jobId,
    projectId: asset.projectId,
    metadata: scrubDeep(metadata),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    url: asset.url
  };
}

function publicShot(shot) {
  if (!shot) return null;
  return {
    id: shot.id,
    projectId: shot.projectId,
    shotIndex: shot.shotIndex,
    shotId: shot.shotId,
    title: shot.title,
    visualPrompt: shot.visualPrompt,
    videoPrompt: shot.videoPrompt,
    camera: shot.camera,
    action: shot.action,
    audio: shot.audio,
    negativePrompt: shot.negativePrompt,
    status: shot.status,
    imageAssetId: shot.imageAssetId,
    videoJobId: shot.videoJobId,
    videoAssetId: shot.videoAssetId,
    metadata: scrubDeep(shot.metadata || {}),
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt
  };
}

function publicProject(project) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    style: project.style,
    status: project.status,
    config: {
      ...defaultProjectConfig(),
      ...(project.config || {})
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function resultSummary(result = {}) {
  return {
    textPreview: result.text ? scrubString(result.text, 600) : undefined,
    stage: result.stage,
    status: result.status,
    referenceMode: result.referenceMode,
    requestedModel: result.requestedModel,
    fallbackFrom: result.fallbackFrom,
    route: result.route,
    routeFallbackFrom: result.routeFallbackFrom,
    routeFallbackError: result.routeFallbackError ? scrubString(result.routeFallbackError, 600) : undefined,
    pollAttempt: result.pollAttempt,
    saveAttempt: result.saveAttempt,
    saveAttempts: result.saveAttempts,
    saveError: result.saveError ? scrubString(result.saveError, 600) : undefined,
    asset: result.asset ? publicAsset(result.asset) : undefined,
    assets: Array.isArray(result.assets) ? result.assets.map(publicAsset) : undefined,
    videos: Array.isArray(result.videos)
      ? result.videos.map((video) => ({
          mime: video.mime,
          source: video.source,
          url: typeof video.url === "string" && video.url.startsWith("/v1/") ? video.url : undefined,
          hasInlineData: Boolean(video.dataUrl)
        }))
      : undefined
  };
}

function publicJob(job, options = {}) {
  if (!job) return null;
  const full = options.full === true;
  return {
    ...job,
    config: scrubDeep(job.config || {}),
    result: full ? scrubDeep(job.result || {}) : resultSummary(job.result || {})
  };
}

function textField(value, maxLength = 8000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeShotInput(input = {}, index = 0, projectId = "") {
  const visualPrompt = textField(
    input.visualPrompt || input.visual_prompt || input.imagePrompt || input.image_prompt || input.visual || input.prompt,
    8000
  );
  const camera = textField(input.camera || input.lens || input.camera_movement, 1200);
  const action = textField(input.action || input.motion || input.performance, 1600);
  const audio = textField(input.audio || input.sound || input.dialogue, 1600);
  const videoPrompt = textField(input.videoPrompt || input.video_prompt, 10000);

  return {
    id: input.id || id("shot"),
    projectId,
    shotIndex: Number.isFinite(Number(input.shotIndex ?? input.shot_index))
      ? Number(input.shotIndex ?? input.shot_index)
      : index + 1,
    shotId: textField(input.shotId || input.shot_id || `S${String(index + 1).padStart(2, "0")}`, 80),
    title: textField(input.title || input.name || `镜头 ${index + 1}`, 200),
    visualPrompt,
    videoPrompt,
    camera,
    action,
    audio,
    negativePrompt: textField(input.negativePrompt || input.negative_prompt, 3000),
    status: textField(input.status || "draft", 80),
    imageAssetId: textField(input.imageAssetId || input.image_asset_id, 120),
    videoJobId: textField(input.videoJobId || input.video_job_id, 120),
    videoAssetId: textField(input.videoAssetId || input.video_asset_id, 120),
    metadata: scrubDeep(input.metadata || {})
  };
}

function updateShotFromVideoJob(job, patch) {
  const shotId = job?.config?.shotId;
  if (!shotId) return;
  const shot = store.getShot(shotId);
  if (!shot) return;
  store.updateShot(shotId, {
    videoJobId: job.id,
    ...patch
  });
}

function assertTrustedOrigin(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHost = ["127.0.0.1", "localhost", "::1"].includes(hostname);
    const allowedPort = !parsed.port || parsed.port === String(PORT);
    if (allowedHost && allowedPort) return;
  } catch {
    // Fall through to the rejection below.
  }
  const error = new Error("Rejected cross-origin local API request.");
  error.status = 403;
  throw error;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateNetworkUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const host = parsed.hostname.toLowerCase();
    if (["localhost", "::1", "0.0.0.0"].includes(host)) return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const match = /^172\.(\d+)\./.exec(host);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return true;
  }
}

function imageMimeFromUrl(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".png")) return "image/png";
  return "image/png";
}

function bodyImageToData(body, projectId = "") {
  if (body.imageDataUrl) {
    const parsed = parseDataUrl(body.imageDataUrl);
    if (!parsed) throw new Error("Invalid imageDataUrl.");
    return { dataUrl: body.imageDataUrl, mime: parsed.mime };
  }

  if (body.imageAssetId) {
    const asset = store.getAsset(body.imageAssetId);
    if (!asset) throw new Error("Image asset not found.");
    if (!asset.mime.startsWith("image/")) throw new Error("Selected asset is not an image.");
    if (projectId && asset.projectId !== projectId) throw new Error("Selected image asset does not belong to the current project.");
    return { dataUrl: dataUrlFromFile(asset.path, asset.mime), mime: asset.mime, asset };
  }

  if (body.imageUrl) {
    const imageUrl = String(body.imageUrl || "").trim();
    if (!isHttpUrl(imageUrl)) throw new Error("Image URL must be an http(s) URL.");
    if (isPrivateNetworkUrl(imageUrl)) throw new Error("Image URL must be a public http(s) URL. Upload local files instead.");
    return { url: imageUrl, mime: imageMimeFromUrl(imageUrl) };
  }

  return null;
}

function videoImageFromConfig(config = {}) {
  const projectId = config.projectId || "";
  if (config.imageAssetId) return bodyImageToData({ imageAssetId: config.imageAssetId }, projectId);
  if (config.imageDataUrl) return bodyImageToData({ imageDataUrl: config.imageDataUrl });
  if (config.imageUrl) return bodyImageToData({ imageUrl: config.imageUrl });
  return null;
}

function videoReferenceImagesFromConfig(config = {}) {
  const refs = [];
  const add = (image) => {
    if (!image) return;
    const key = image.asset?.id || image.url || image.dataUrl;
    if (!key || refs.some((item) => (item.asset?.id || item.url || item.dataUrl) === key)) return;
    refs.push(image);
  };
  add(videoImageFromConfig(config));
  for (const assetId of Array.isArray(config.referenceAssetIds) ? config.referenceAssetIds : []) {
    add(bodyImageToData({ imageAssetId: assetId }, config.projectId || ""));
  }
  for (const item of Array.isArray(config.referenceImages) ? config.referenceImages : []) {
    if (item?.assetId) add(bodyImageToData({ imageAssetId: item.assetId }, config.projectId || ""));
    else if (item?.imageDataUrl) add(bodyImageToData({ imageDataUrl: item.imageDataUrl }));
    else if (item?.imageUrl) add(bodyImageToData({ imageUrl: item.imageUrl }));
  }
  return refs.slice(0, 3);
}

function imageDimensionsFromReference(image) {
  const metadata = image?.asset?.metadata || {};
  if (metadata.width && metadata.height) {
    return {
      width: Number(metadata.width),
      height: Number(metadata.height)
    };
  }
  if (image?.asset?.path) {
    const dimensions = imageDimensionsFromFile(image.asset.path);
    if (dimensions) return dimensions;
  }
  if (image?.dataUrl) {
    const parsed = parseDataUrl(image.dataUrl);
    if (parsed?.data) return imageDimensionsFromBuffer(parsed.data);
  }
  return null;
}

function referenceOrientation(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return "";
  if (dimensions.width > dimensions.height * 1.08) return "landscape";
  if (dimensions.height > dimensions.width * 1.08) return "portrait";
  return "square";
}

function latestProjectVideoReferenceAssetId(projectId = "") {
  if (!projectId) return "";
  return store.listAssets(120, projectId).find((asset) => (
    asset.kind === "image" &&
    asset.source === "video-reference"
  ))?.id || "";
}

function videoReferenceMode(config = {}) {
  if (config.referenceMode === "vision_prompt") return "vision_prompt";
  if (config.referenceMode === "native_json") return "native_json";
  if (config.referenceMode === "json") return "native_json";
  if (config.referenceMode === "native") return "native_multipart";
  if (config.referenceMode === "native_multipart") return "native_multipart";
  return "none";
}

function normalizeVideoDuration(rawDuration, { resolution = "720p", hasReference = false } = {}) {
  const duration = String(rawDuration || "8").trim();
  const normalizedResolution = String(resolution || "").toLowerCase();
  if (hasReference && duration !== "8") {
    return {
      duration: "8",
      error: "上传参考图或填写参考图 URL 后，图生视频只支持 8 秒。"
    };
  }
  if ((normalizedResolution === "1080p" || normalizedResolution === "4k") && duration !== "8") {
    return {
      duration: "8",
      error: "1080p 和 4K 视频只支持 8 秒。"
    };
  }
  if (!["4", "6", "8"].includes(duration)) {
    return {
      duration: "8",
      error: "当前视频模型只支持 4、6 或 8 秒。"
    };
  }
  return { duration, error: "" };
}

function validateVideoOutputCombination({ aspectRatio = "16:9", resolution = "720p", hasReference = false, referenceImages = [] } = {}) {
  const normalizedAspectRatio = String(aspectRatio || "16:9").trim();
  const normalizedResolution = String(resolution || "720p").toLowerCase();
  if (hasReference && normalizedAspectRatio === "9:16" && normalizedResolution !== "720p") {
    return "当前中转站的竖屏参考图生视频只支持 720p。";
  }
  const firstReference = Array.isArray(referenceImages) ? referenceImages[0] : null;
  const orientation = referenceOrientation(imageDimensionsFromReference(firstReference));
  if (hasReference && orientation === "portrait" && normalizedAspectRatio === "16:9") {
    return "参考图是竖图，请选择 9:16 或上传横图后再生成。";
  }
  if (hasReference && orientation === "landscape" && normalizedAspectRatio === "9:16") {
    return "参考图是横图，请选择 16:9 或上传竖图后再生成。";
  }
  return "";
}

function cleanVideoPrompt(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildCompatibleImageVideoPrompt(userPrompt, referenceText) {
  const prompt = cleanVideoPrompt(userPrompt) || "保持参考画面一致。";
  const reference = cleanVideoPrompt(referenceText).slice(0, 1800);
  return [
    "根据以下视觉参考生成短视频。开场画面尽量接近参考画面，保持主体身份、性别、年龄感、服装、场景、构图、光线、色彩等可见信息一致。",
    "不要改写用户指定的人物性别、身份或其他内容；动作和镜头只按用户提示词执行。",
    "",
    "视觉参考：",
    reference,
    "",
    "动作与镜头要求：",
    prompt
  ].join("\n");
}

async function saveFirstVideo(job, videos, client = oneapi) {
  if (!videos.length) return null;
  const video = videos[0];
  const value = video.dataUrl || video.url;
  const assetUrl = typeof value === "string" && value.startsWith("/")
    ? `${client.baseUrl}${value}`
    : value;
  return saveRemoteOrDataAsset({
    store,
    assetsDir: ASSETS_DIR,
    kind: "video",
    value: assetUrl,
    mime: video.mime,
    prompt: job.prompt,
    model: job.model,
    jobId: job.id,
    projectId: job.projectId,
    source: video.source,
    metadata: { remoteId: job.remoteId },
    authHeaders: client.authHeaders()
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function videoSaveRetryDelays() {
  const raw = env("VIDEO_SAVE_RETRY_DELAYS_MS", DEFAULT_VIDEO_SAVE_RETRY_DELAYS);
  const parsed = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : [0, 5000, 15000, 30000, 60000];
}

async function saveFirstVideoWithRetries(job, state, pollAttempt, client = oneapi) {
  const delays = videoSaveRetryDelays();
  let lastError;
  const baseResult = job.result || {};

  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index]) await wait(delays[index]);
    appendServerLog("video.save", `job=${job.id} attempt=${index + 1}/${delays.length} remoteId=${job.remoteId || "-"}`);
    store.updateJob(job.id, {
      status: "saving",
      error: "",
      result: {
        ...baseResult,
        raw: state.raw,
        status: state.status,
        videos: state.videos,
        pollAttempt,
        saveAttempt: index + 1,
        saveAttempts: delays.length
      }
    });

    try {
      const asset = await saveFirstVideo(job, state.videos, client);
      appendServerLog("video.save", `job=${job.id} attempt=${index + 1} saved asset=${asset?.id || "-"}`);
      return asset;
    } catch (error) {
      lastError = error;
      appendServerLog("video.save.error", `job=${job.id} attempt=${index + 1} ${error?.message || String(error)}`);
    }
  }

  store.updateJob(job.id, {
    status: "save_failed",
    error: `${lastError?.message || "Failed to save video asset"}. The remote task succeeded, so retry will only download the existing video.`,
    result: {
      ...baseResult,
      raw: state.raw,
      status: state.status,
      videos: state.videos,
      pollAttempt,
      saveError: lastError?.message || "Failed to save video asset"
    }
  });
  updateShotFromVideoJob(job, { status: "video_save_failed" });
  appendServerLog("video.save.failed", `job=${job.id} ${lastError?.message || "Failed to save video asset"}`);
  return null;
}

function videoErrorMessage(raw) {
  const status = String(raw?.data?.status || raw?.status || "").toLowerCase();
  const dataUrl = raw?.data?.url;
  const dataError = raw?.data?.error;

  if (raw?.error?.message) return raw.error.message;
  if (dataError?.message) return dataError.message;
  if (typeof dataError === "string" && dataError.trim()) return dataError.trim();
  if (status === "failed" && typeof dataUrl === "string" && dataUrl.trim() && !/^https?:\/\//i.test(dataUrl)) {
    return dataUrl.trim();
  }
  if (raw?.message) return raw.message;
  const remoteId = raw?.id || raw?.task_id || raw?.taskId || "";
  return remoteId
    ? `OneAPI video task ${remoteId} failed, but the provider did not return a detailed error.`
    : "OneAPI video task failed. The provider did not return a detailed error.";
}

function isSaveRetryJob(job) {
  return (
    Boolean(job.remoteId) &&
    !job.assetId &&
    (job.status === "save_failed" ||
      /failed to download asset|resolve vertex video url|remote task succeeded/i.test(job.error || ""))
  );
}

function videoFailureRetryPlan(job, state) {
  const result = job?.result || {};
  const history = Array.isArray(result.retryHistory) ? result.retryHistory : [];
  if (history.length) return null;

  const config = job?.config || {};
  const hasReference = Boolean(
    config.imageAssetId ||
      config.imageUrl ||
      config.referenceImageCount ||
      (Array.isArray(config.referenceAssetIds) && config.referenceAssetIds.length)
  );
  const route = result.route || config.videoRoute || "";
  const reason = videoErrorMessage(state?.raw);
  const fallbackModel = config.videoFallbackModel && config.videoFallbackModel !== job.model
    ? config.videoFallbackModel
    : job.model;

  if (hasReference) {
    return null;
  }

  if (config.videoFallbackModel && config.videoFallbackModel !== job.model) {
    return {
      mode: "model_fallback",
      model: config.videoFallbackModel,
      route,
      reason
    };
  }

  return null;
}

async function retryFailedVideoState(jobClient, job, state, pollAttempt = 0) {
  const plan = videoFailureRetryPlan(job, state);
  if (!plan) return null;

  const currentResult = job.result || {};
  const retryHistory = Array.isArray(currentResult.retryHistory) ? currentResult.retryHistory : [];
  let retryPrompt = job.prompt;

  const nextConfig = {
    ...job.config,
    referenceMode: "none",
    videoRoute: plan.mode,
    imageAssetId: "",
    referenceAssetIds: [],
    referenceImageCount: 0,
    imageUrl: "",
    routeFallbackFrom: plan.route,
    routeFallbackError: plan.reason
  };

  appendServerLog(
    "video.retry",
    `job=${job.id} mode=${plan.mode} model=${plan.model} fromRoute=${plan.route || "-"} reason=${plan.reason}`
  );

  job = store.updateJob(job.id, {
    status: "running",
    model: plan.model,
    remoteId: "",
    error: "",
    config: nextConfig,
    result: {
      ...currentResult,
      raw: state.raw,
      pollAttempt,
      retryHistory: [
        ...retryHistory,
        {
          mode: plan.mode,
          model: plan.model,
          route: plan.route || "",
          remoteId: job.remoteId || "",
          reason: plan.reason,
          at: new Date().toISOString()
        }
      ],
      routeFallbackFrom: plan.route,
      routeFallbackError: plan.reason
    }
  });
  updateShotFromVideoJob(job, { status: "video_retrying" });

  const nextState = await jobClient.startVideo({
    model: plan.model,
    prompt: retryPrompt,
    image: null,
    images: [],
    config: nextConfig
  });
  nextState.route = nextState.route || plan.mode;
  nextState.routeFallbackFrom = plan.route;
  nextState.routeFallbackError = plan.reason;
  return nextState;
}

async function processVideoJob(jobId) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  try {
    let job = store.getJob(jobId);
    if (!job) return;
    const jobClient = clientForJob(job);
    appendServerLog("video.job", `start job=${job.id} model=${job.model} remoteId=${job.remoteId || "-"}`);

    store.updateJob(jobId, { status: "running", error: "" });
    job = store.getJob(jobId);
    updateShotFromVideoJob(job, { status: "video_running" });

    let state;
    if (job.remoteId) {
      state = await jobClient.pollVideo(job.remoteId, { route: job.config?.videoRoute });
    } else {
      const referenceImages = videoReferenceImagesFromConfig(job.config);
      const image = referenceImages[0] || null;
      let videoPrompt = job.prompt;
      let videoImage = image;
      let videoImages = referenceImages;
      const mode = referenceImages.length ? videoReferenceMode(job.config) : "none";

      if (image && mode === "vision_prompt") {
        store.updateJob(jobId, {
          status: "running",
          result: {
            stage: "analyzing_reference",
            referenceMode: "vision_prompt"
          }
        });

        const reference = await jobClient.describeImageForVideo({
          model: job.config.visionModel,
          prompt: job.prompt,
          image
        });
        videoPrompt = buildCompatibleImageVideoPrompt(job.prompt, reference.text);
        videoImage = null;
        videoImages = [];

        store.updateJob(jobId, {
          status: "running",
          result: {
            stage: "starting_video",
            referenceMode: "vision_prompt",
            referenceDescription: reference.text,
            effectivePrompt: videoPrompt,
            visionRaw: reference.raw
          }
        });
      }

      if (image && mode === "native_multipart") {
        state = await jobClient.startVideoMultipart({
          model: job.model,
          prompt: videoPrompt,
          image: videoImage,
          images: videoImages,
          config: job.config
        });
      } else {
        state = await jobClient.startVideo({
          model: job.model,
          prompt: videoPrompt,
          image: videoImage,
          images: videoImages,
          config: {
            ...job.config,
            compatibleImageToVideo: image && mode === "vision_prompt"
          }
        });
      }
    }

    let previousResult = store.getJob(jobId)?.result || {};
    job = store.updateJob(jobId, {
      status: state.done ? "saving" : "polling",
      model: state.model || job.model,
      remoteId: state.remoteId || job.remoteId,
      result: {
        ...previousResult,
        raw: state.raw,
        status: state.status,
        requestedModel: state.requestedModel,
        fallbackFrom: state.fallbackFrom,
        route: state.route || job.config?.videoRoute || "",
        routeFallbackFrom: state.routeFallbackFrom || previousResult.routeFallbackFrom,
        routeFallbackError: state.routeFallbackError || previousResult.routeFallbackError
      }
    });
    appendServerLog(
      "video.state",
      `job=${job.id} status=${state.status || "-"} done=${state.done ? "yes" : "no"} failed=${state.failed ? "yes" : "no"} remoteId=${state.remoteId || job.remoteId || "-"}`
    );

    if (state.failed) {
      const retryState = await retryFailedVideoState(jobClient, store.getJob(jobId), state, 0);
      if (!retryState) {
        store.updateJob(jobId, {
          status: "failed",
          error: videoErrorMessage(state.raw),
          result: { ...previousResult, raw: state.raw }
        });
        updateShotFromVideoJob(job, { status: "video_failed" });
        appendServerLog("video.failed", `job=${job.id} ${videoErrorMessage(state.raw)}`);
        return;
      }

      state = retryState;
      previousResult = store.getJob(jobId)?.result || {};
      job = store.updateJob(jobId, {
        status: state.done ? "saving" : "polling",
        model: state.model || store.getJob(jobId)?.model || job.model,
        remoteId: state.remoteId || "",
        result: {
          ...previousResult,
          raw: state.raw,
          status: state.status,
          requestedModel: state.requestedModel,
          fallbackFrom: state.fallbackFrom,
          route: state.route || "retry",
          routeFallbackFrom: state.routeFallbackFrom || previousResult.routeFallbackFrom,
          routeFallbackError: state.routeFallbackError || previousResult.routeFallbackError
        }
      });
      appendServerLog(
        "video.state",
        `job=${job.id} retryStatus=${state.status || "-"} done=${state.done ? "yes" : "no"} failed=${state.failed ? "yes" : "no"} remoteId=${state.remoteId || job.remoteId || "-"}`
      );

      if (state.failed) {
        store.updateJob(jobId, {
          status: "failed",
          error: videoErrorMessage(state.raw),
          result: { ...(store.getJob(jobId)?.result || {}), raw: state.raw }
        });
        updateShotFromVideoJob(job, { status: "video_failed" });
        appendServerLog("video.failed", `job=${job.id} retry ${videoErrorMessage(state.raw)}`);
        return;
      }
    }

    if (state.done && state.videos.length) {
      const asset = await saveFirstVideoWithRetries(job, state, undefined, jobClient);
      if (asset) {
          store.updateJob(jobId, {
            status: "completed",
            assetId: asset.id,
            result: { ...previousResult, status: state.status, asset, videos: state.videos, raw: state.raw }
          });
          updateShotFromVideoJob(job, {
            status: "video_completed",
            videoAssetId: asset.id
          });
        }
        return;
      }

    const intervalMs = envInt("VIDEO_POLL_INTERVAL_MS", 10000);
    const maxPolls = envInt("VIDEO_MAX_POLLS", 90);
    for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      job = store.getJob(jobId);
      if (!job || !job.remoteId) break;

      state = await jobClient.pollVideo(job.remoteId, { route: job.config?.videoRoute });
      store.updateJob(jobId, {
        status: state.done ? "saving" : "polling",
        model: state.model || job.model,
        result: { ...(job.result || {}), raw: state.raw, status: state.status, pollAttempt: attempt }
      });
      updateShotFromVideoJob(job, { status: state.done ? "video_saving" : "video_polling" });

      if (state.failed) {
        const retryState = await retryFailedVideoState(jobClient, store.getJob(jobId), state, attempt);
        if (!retryState) {
          store.updateJob(jobId, {
            status: "failed",
            error: videoErrorMessage(state.raw),
            result: { ...(job.result || {}), raw: state.raw, pollAttempt: attempt }
          });
          updateShotFromVideoJob(job, { status: "video_failed" });
          appendServerLog("video.failed", `job=${job.id} pollAttempt=${attempt} ${videoErrorMessage(state.raw)}`);
          return;
        }

        state = retryState;
        job = store.getJob(jobId);
        store.updateJob(jobId, {
          status: state.done ? "saving" : "polling",
          model: state.model || job.model,
          remoteId: state.remoteId || "",
          result: {
            ...(job.result || {}),
            raw: state.raw,
            status: state.status,
            pollAttempt: attempt,
            requestedModel: state.requestedModel,
            fallbackFrom: state.fallbackFrom,
            route: state.route || "retry",
            routeFallbackFrom: state.routeFallbackFrom || job.result?.routeFallbackFrom,
            routeFallbackError: state.routeFallbackError || job.result?.routeFallbackError
          }
        });
        job = store.getJob(jobId);
        updateShotFromVideoJob(job, { status: state.done ? "video_saving" : "video_polling" });
        appendServerLog(
          "video.state",
          `job=${job.id} retryPollAttempt=${attempt} status=${state.status || "-"} done=${state.done ? "yes" : "no"} failed=${state.failed ? "yes" : "no"} remoteId=${state.remoteId || job.remoteId || "-"}`
        );

        if (state.failed) {
          store.updateJob(jobId, {
            status: "failed",
            error: videoErrorMessage(state.raw),
            result: { ...(job.result || {}), raw: state.raw, pollAttempt: attempt }
          });
          updateShotFromVideoJob(job, { status: "video_failed" });
          appendServerLog("video.failed", `job=${job.id} retryPollAttempt=${attempt} ${videoErrorMessage(state.raw)}`);
          return;
        }
      }

      if (state.done && state.videos.length) {
        const asset = await saveFirstVideoWithRetries(job, state, attempt, jobClient);
        if (asset) {
          store.updateJob(jobId, {
            status: "completed",
            assetId: asset.id,
            result: { ...(job.result || {}), status: state.status, asset, videos: state.videos, raw: state.raw, pollAttempt: attempt }
          });
          updateShotFromVideoJob(job, {
            status: "video_completed",
            videoAssetId: asset.id
          });
        }
        return;
      }
    }

    store.updateJob(jobId, {
      status: "failed",
      error: "Video task timed out before a downloadable video was found."
    });
    updateShotFromVideoJob(store.getJob(jobId), { status: "video_failed" });
  } catch (error) {
    store.updateJob(jobId, {
      status: "failed",
      error: error.message,
      result: { details: error.payload }
    });
    updateShotFromVideoJob(store.getJob(jobId), { status: "video_failed" });
    appendServerLog("video.exception", `job=${jobId} ${error?.stack || error?.message || String(error)}`);
  } finally {
    activeJobs.delete(jobId);
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const settings = runtimeSettings();
    sendJson(res, 200, {
      ok: true,
      configured: oneapi.isConfigured(),
      baseUrl: oneapi.baseUrl,
      configDir: CONFIG_DIR,
      dataDir: DATA_DIR,
      host: HOST,
      port: PORT,
      logFile: SERVER_LOG_FILE,
      models: modelCatalog(),
      settings,
      activeJobs: Array.from(activeJobs)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, { ok: true, settings: runtimeSettings() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/debug/logs") {
    const limit = url.searchParams.get("limit") || "180";
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      configDir: CONFIG_DIR,
      dataDir: DATA_DIR,
      host: HOST,
      port: PORT,
      logFile: SERVER_LOG_FILE,
      recentJobs: store.listJobs(20).map((job) => publicJob(job)),
      videoConfig: {
        createPath: env("VIDEO_CREATE_PATH", "/v1/video/generations"),
        openaiCreatePath: env("VIDEO_OPENAI_CREATE_PATH", "/v1/videos"),
        pollPaths: env("VIDEO_POLL_PATHS", "/v1/video/generations/{id},/v1/videos/{id}"),
        requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 120000),
        imageRequestTimeoutMs: envInt("IMAGE_REQUEST_TIMEOUT_MS", 300000),
        assetDownloadTimeoutMs: effectiveAssetDownloadTimeoutMs(),
        saveRetryDelaysMs: env("VIDEO_SAVE_RETRY_DELAYS_MS", DEFAULT_VIDEO_SAVE_RETRY_DELAYS)
      },
      lines: tailServerLogLines(limit)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/debug/report") {
    sendJson(res, 200, diagnosticReport());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    sendJson(res, 200, { ok: true, models: modelCatalog() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const updates = {};
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      updates.ONEAPI_BASE_URL = sanitizeConfigBaseUrl(body.baseUrl);
    }
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      updates.ONEAPI_API_KEY = sanitizeConfigApiKey(body.apiKey);
    }
    const routes = body.routes || {};
    const models = body.models || {};
    if (typeof body.chatPath === "string" || typeof routes.chatPath === "string") {
      updates.OPENAI_CHAT_PATH = normalizeApiPath(body.chatPath || routes.chatPath, DEFAULT_PATHS.chatPath);
    }
    if (typeof body.imageChatPath === "string" || typeof routes.imageChatPath === "string") {
      updates.IMAGE_CHAT_PATH = normalizeApiPath(body.imageChatPath || routes.imageChatPath, DEFAULT_PATHS.imageChatPath);
    }
    if (typeof body.videoCreatePath === "string" || typeof routes.videoCreatePath === "string") {
      updates.VIDEO_CREATE_PATH = normalizeApiPath(body.videoCreatePath || routes.videoCreatePath, DEFAULT_PATHS.videoCreatePath);
    }
    if (typeof body.videoOpenaiCreatePath === "string" || typeof routes.videoOpenaiCreatePath === "string") {
      updates.VIDEO_OPENAI_CREATE_PATH = normalizeApiPath(body.videoOpenaiCreatePath || routes.videoOpenaiCreatePath, DEFAULT_PATHS.videoOpenaiCreatePath);
    }
    if (typeof body.videoPollPaths === "string" || typeof routes.videoPollPaths === "string") {
      updates.VIDEO_POLL_PATHS = normalizePollPaths(body.videoPollPaths || routes.videoPollPaths);
    }
    const modelMap = {
      textModel: "TEXT_MODEL",
      fastTextModel: "FAST_TEXT_MODEL",
      visionModel: "VISION_MODEL",
      imageModel: "IMAGE_MODEL",
      videoModel: "VIDEO_MODEL",
      videoFallbackModel: "VIDEO_FALLBACK_MODEL"
    };
    for (const [inputKey, envKey] of Object.entries(modelMap)) {
      const value = body[inputKey] || models[inputKey];
      if (typeof value === "string" && value.trim()) updates[envKey] = value.trim();
    }
    if (!Object.keys(updates).length) {
      sendError(res, 400, new Error("没有可保存的配置。"));
      return;
    }
    updateEnvFile(CONFIG_DIR, updates);
    oneapi.reload();
    sendJson(res, 200, {
      ok: true,
      configured: oneapi.isConfigured(),
      baseUrl: oneapi.baseUrl,
      settings: runtimeSettings()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, { ok: true, projects: store.listProjects({ includeArchived: url.searchParams.get("archived") === "1" }).map(publicProject) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(req);
    const project = store.createProject({
      id: id("project"),
      name: body.name || "未命名项目",
      description: body.description || "",
      style: body.style || "",
      config: cleanProjectConfig(body.config || body)
    });
    sendJson(res, 201, { ok: true, project: publicProject(project) });
    return;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && projectMatch) {
    const project = store.getProject(projectMatch[1]);
    if (!project) {
      sendError(res, 404, new Error("Project not found."));
      return;
    }
    sendJson(res, 200, { ok: true, project: publicProject(project) });
    return;
  }

  if (req.method === "PATCH" && projectMatch) {
    const current = store.getProject(projectMatch[1]);
    if (!current) {
      sendError(res, 404, new Error("Project not found."));
      return;
    }
    const body = await readJson(req);
    const nextConfig = {
      ...(current.config || {}),
      ...cleanProjectConfig(body.config || body)
    };
    const project = store.updateProject(current.id, {
      name: body.name === undefined ? current.name : body.name,
      description: body.description === undefined ? current.description : body.description,
      style: body.style === undefined ? current.style : body.style,
      status: body.status === undefined ? current.status : body.status,
      config: nextConfig
    });
    sendJson(res, 200, { ok: true, project: publicProject(project) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const projectId = url.searchParams.has("projectId") ? url.searchParams.get("projectId") || "" : null;
    sendJson(res, 200, { ok: true, jobs: store.listJobs(80, projectId).map((job) => publicJob(job)) });
    return;
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && jobMatch) {
    const job = store.getJob(jobMatch[1]);
    if (!job) {
      sendError(res, 404, new Error("Job not found."));
      return;
    }
    sendJson(res, 200, { ok: true, job: publicJob(job, { full: url.searchParams.get("full") === "1" }) });
    return;
  }

  const retryMatch = /^\/api\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (req.method === "POST" && retryMatch) {
    const job = store.getJob(retryMatch[1]);
    if (!job) {
      sendError(res, 404, new Error("Job not found."));
      return;
    }
    if (job.type !== "video") {
      sendError(res, 400, new Error("Only video jobs use background retry."));
      return;
    }
    if (isSaveRetryJob(job)) {
      store.updateJob(job.id, { status: "queued", error: "" });
    } else {
      store.updateJob(job.id, { status: "queued", error: "", remoteId: "", result: {} });
    }
    processVideoJob(job.id);
    sendJson(res, 200, { ok: true, job: publicJob(store.getJob(job.id)) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const projectId = url.searchParams.has("projectId") ? url.searchParams.get("projectId") || "" : null;
    sendJson(res, 200, { ok: true, assets: store.listAssets(120, projectId).map(publicAsset) });
    return;
  }

  const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(url.pathname);
  if (req.method === "PATCH" && assetMatch) {
    const current = store.getAsset(assetMatch[1]);
    if (!current) {
      sendError(res, 404, new Error("Asset not found."));
      return;
    }
    const body = await readJson(req);
    const metadataPatch = cleanAssetMetadata({
      metadata: {
        ...(current.metadata || {}),
        ...(body.metadata || {})
      },
      libraryType: body.libraryType,
      libraryTitle: body.libraryTitle || body.title,
      title: body.title,
      parentAssetId: body.parentAssetId,
      shotId: body.shotId,
      role: body.role
    });
    const updated = store.updateAsset(current.id, {
      prompt: body.prompt === undefined ? current.prompt : textField(body.prompt, 12000),
      source: body.source === undefined ? current.source : textField(body.source, 600),
      model: body.model === undefined ? current.model : textField(body.model, 200),
      projectId: body.projectId === undefined ? current.projectId : textField(body.projectId, 120),
      metadata: metadataPatch
    });
    sendJson(res, 200, { ok: true, asset: publicAsset(updated) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shots") {
    const hasProjectParam = url.searchParams.has("projectId");
    const projectId = hasProjectParam ? url.searchParams.get("projectId") || "" : null;
    sendJson(res, 200, { ok: true, shots: store.listShots(projectId).map(publicShot) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/shots/import") {
    const body = await readJson(req);
    const rawShots = Array.isArray(body.shots) ? body.shots : [];
    if (!rawShots.length) {
      sendError(res, 400, new Error("No shots to import."));
      return;
    }
    if (rawShots.length > 200) {
      sendError(res, 400, new Error("Too many shots. Import at most 200 at a time."));
      return;
    }
    const projectId = body.projectId || "";
    const shots = rawShots.map((shot, index) => normalizeShotInput(shot, index, projectId));
    const created = body.replace === false
      ? shots.map((shot) => store.createShot(shot))
      : store.replaceProjectShots(projectId, shots);
    sendJson(res, 201, { ok: true, shots: created.map(publicShot) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/shots") {
    const body = await readJson(req);
    const shot = store.createShot(normalizeShotInput(body, 0, body.projectId || ""));
    sendJson(res, 201, { ok: true, shot: publicShot(shot) });
    return;
  }

  const shotMatch = /^\/api\/shots\/([^/]+)$/.exec(url.pathname);
  if (req.method === "PATCH" && shotMatch) {
    const current = store.getShot(shotMatch[1]);
    if (!current) {
      sendError(res, 404, new Error("Shot not found."));
      return;
    }
    const body = await readJson(req);
    const patch = normalizeShotInput({ ...current, ...body }, current.shotIndex - 1, current.projectId);
    const updated = store.updateShot(current.id, patch);
    sendJson(res, 200, { ok: true, shot: publicShot(updated) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/text/generate") {
    const body = await readJson(req);
    const projectConfig = effectiveProjectConfig(body.projectId || "");
    const jobClient = new OneApiClient(routeOverridesFromConfig(projectConfig));
    const job = store.createJob({
      id: id("job"),
      type: "text",
      status: "running",
      model: body.model || projectConfig.textModel,
      prompt: body.prompt || "",
      projectId: body.projectId || "",
      config: {
        system: body.system || "",
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        routeOverrides: routeOverridesFromConfig(projectConfig)
      }
    });

    try {
      const result = await jobClient.generateText({
        model: job.model,
        prompt: job.prompt,
        system: body.system || "",
        temperature: body.temperature,
        maxTokens: body.maxTokens
      });
      const updated = store.updateJob(job.id, {
        status: "completed",
        result: { text: result.text, raw: result.raw }
      });
      sendJson(res, 200, { ok: true, job: publicJob(updated), text: result.text });
    } catch (error) {
      const updated = store.updateJob(job.id, {
        status: "failed",
        error: error.message,
        result: { details: error.payload }
      });
      sendJson(res, 502, { ok: false, job: publicJob(updated), error: error.message, details: scrubDeep(error.payload) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/video/prompt/analyze") {
    const body = await readJson(req);
    const projectConfig = effectiveProjectConfig(body.projectId || "");
    const jobClient = new OneApiClient(routeOverridesFromConfig(projectConfig));
    const image = bodyImageToData(body, body.projectId || "");
    if (!image) {
      sendError(res, 400, new Error("A storyboard frame image is required."));
      return;
    }
    const prompt = textField(body.prompt || "", 12000);
    const job = store.createJob({
      id: id("job"),
      type: "text",
      status: "running",
      model: body.model || projectConfig.visionModel || projectConfig.textModel,
      prompt,
      projectId: body.projectId || "",
      config: {
        mode: "video_prompt_from_frame",
        shotId: body.shotId || "",
        imageAssetId: body.imageAssetId || "",
        routeOverrides: routeOverridesFromConfig(projectConfig)
      }
    });

    try {
      const result = await jobClient.describeImageForVideo({
        model: job.model,
        prompt,
        image
      });
      if (body.shotId && store.getShot(body.shotId)) {
        const currentShot = store.getShot(body.shotId);
        store.updateShot(body.shotId, {
          videoPrompt: result.text,
          metadata: {
            ...(currentShot.metadata || {}),
            videoPromptAgent: {
              source: "frame-analysis",
              jobId: job.id,
              imageAssetId: body.imageAssetId || ""
            }
          }
        });
      }
      const updated = store.updateJob(job.id, {
        status: "completed",
        result: { text: result.text, raw: result.raw }
      });
      sendJson(res, 200, { ok: true, job: publicJob(updated), text: result.text });
    } catch (error) {
      const updated = store.updateJob(job.id, {
        status: "failed",
        error: error.message,
        result: { details: error.payload }
      });
      sendJson(res, 502, { ok: false, job: publicJob(updated), error: error.message, details: scrubDeep(error.payload) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/image/generate") {
    const body = await readJson(req);
    const projectConfig = effectiveProjectConfig(body.projectId || "");
    const jobClient = new OneApiClient(routeOverridesFromConfig(projectConfig));
    const aspectRatio = body.aspectRatio || projectConfig.aspectRatio;
    const imageSize = body.imageSize || projectConfig.imageSize;
    const referenceAssetIds = cleanReferenceAssetIds(body.referenceAssetIds || body.reference_asset_ids || [], body.projectId || "");
    const assetMetadata = cleanAssetMetadata({
      metadata: body.metadata || {},
      libraryType: body.libraryType || (body.shotId ? "keyframe" : "general"),
      libraryTitle: body.libraryTitle || body.title,
      parentAssetId: body.parentAssetId || body.imageAssetId,
      shotId: body.shotId || "",
      role: body.role || ""
    });
    const job = store.createJob({
      id: id("job"),
      type: "image",
      status: "running",
      model: body.model || projectConfig.imageModel,
      prompt: body.prompt || "",
      projectId: body.projectId || "",
      config: {
        aspectRatio,
        imageSize,
        hasInputImage: Boolean(body.imageDataUrl || body.imageAssetId || referenceAssetIds.length),
        shotId: body.shotId || "",
        libraryType: assetMetadata.libraryType || "general",
        libraryTitle: assetMetadata.title || "",
        parentAssetId: assetMetadata.parentAssetId || "",
        referenceAssetIds,
        routeOverrides: routeOverridesFromConfig(projectConfig)
      }
    });

    try {
      const image = bodyImageToData(body, body.projectId || "");
      const inputImages = [
        image,
        ...referenceAssetIds.map((assetId) => bodyImageToData({ imageAssetId: assetId }, body.projectId || ""))
      ].filter(Boolean).slice(0, 3);
      const result = await jobClient.generateImage({
        model: job.model,
        prompt: job.prompt,
        inputImages,
        aspectRatio,
        imageSize
      });

      const assets = [];
      for (const imageResult of result.images) {
        const asset = await saveRemoteOrDataAsset({
          store,
          assetsDir: ASSETS_DIR,
          kind: "image",
          value: imageResult.dataUrl || imageResult.url,
          mime: imageResult.mime,
          prompt: job.prompt,
          model: job.model,
          jobId: job.id,
          projectId: job.projectId,
          source: imageResult.source,
          metadata: {
            ...assetMetadata,
            sourceJobType: "image_generation"
          },
          authHeaders: jobClient.authHeaders()
        });
        assets.push(asset);
      }

      if (body.shotId && assets[0] && store.getShot(body.shotId)) {
        store.updateShot(body.shotId, {
          imageAssetId: assets[0].id,
          status: "keyframe_ready"
        });
      }

      const updated = store.updateJob(job.id, {
        status: assets.length ? "completed" : "completed_no_asset",
        assetId: assets[0]?.id || "",
        result: { text: result.text, assets, raw: result.raw }
      });
      sendJson(res, 200, { ok: true, job: publicJob(updated), text: result.text, assets: assets.map(publicAsset) });
    } catch (error) {
      const updated = store.updateJob(job.id, {
        status: "failed",
        error: error.message,
        result: { details: error.payload }
      });
      sendJson(res, 502, { ok: false, job: publicJob(updated), error: error.message, details: scrubDeep(error.payload) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/video/generate") {
    const body = await readJson(req);
    const projectConfig = effectiveProjectConfig(body.projectId || "");
    const image = bodyImageToData(body, body.projectId || "");
    let imageAssetId = body.imageDataUrl
      ? ""
      : (body.imageAssetId ||
          projectConfig.videoReferenceAssetId ||
          latestProjectVideoReferenceAssetId(body.projectId || "") ||
          image?.asset?.id ||
          "");
    let imageUrl = !imageAssetId && body.imageUrl ? String(body.imageUrl).trim() : "";
    if (!imageAssetId && body.imageDataUrl) {
      const referenceAsset = await saveRemoteOrDataAsset({
        store,
        assetsDir: ASSETS_DIR,
        kind: "image",
        value: body.imageDataUrl,
        mime: image?.mime,
        prompt: body.prompt || "",
        model: "user-upload",
        jobId: "",
        projectId: body.projectId || "",
        source: "video-reference",
        metadata: { role: "video-reference" }
      });
      imageAssetId = referenceAsset.id;
      imageUrl = "";
    }
    if (imageUrl) bodyImageToData({ imageUrl }, body.projectId || "");
    if (imageAssetId) bodyImageToData({ imageAssetId }, body.projectId || "");

    const requestedReferenceAssetIds = cleanReferenceAssetIds(body.referenceAssetIds || body.reference_asset_ids || [], body.projectId || "");
    const referenceAssetIds = [imageAssetId, ...requestedReferenceAssetIds]
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 3);
    if (!imageAssetId && referenceAssetIds.length) imageAssetId = referenceAssetIds[0];

    const hasReferenceImage = Boolean(imageAssetId || imageUrl || referenceAssetIds.length);
    const personGeneration = body.personGeneration || projectConfig.personGeneration || (hasReferenceImage ? "allow_adult" : "");
    const requestedMode = body.referenceMode || projectConfig.referenceMode || "";
    const referenceMode = hasReferenceImage
      ? (["native_multipart", "native_json", "vision_prompt"].includes(requestedMode)
          ? requestedMode
          : requestedMode === "native"
            ? "native_multipart"
            : "native_multipart")
      : "none";
    const videoRoute = referenceMode === "native_multipart" ? "openai_multipart" : "";
    const aspectRatio = body.aspectRatio || projectConfig.aspectRatio;
    const resolution = body.resolution || projectConfig.resolution;
    const referenceImagesForValidation = hasReferenceImage
      ? videoReferenceImagesFromConfig({
          projectId: body.projectId || "",
          imageAssetId,
          imageUrl,
          referenceAssetIds
        })
      : [];
    const outputError = validateVideoOutputCombination({
      aspectRatio,
      resolution,
      hasReference: hasReferenceImage,
      referenceImages: referenceImagesForValidation
    });
    if (outputError) {
      sendJson(res, 400, { ok: false, error: outputError });
      return;
    }
    const durationRule = normalizeVideoDuration(body.duration || projectConfig.duration, {
      resolution,
      hasReference: hasReferenceImage
    });
    if (durationRule.error) {
      sendJson(res, 400, { ok: false, error: durationRule.error });
      return;
    }
    const duration = durationRule.duration;
    const currentShot = body.shotId ? store.getShot(body.shotId) : null;
    const project = body.projectId ? store.getProject(body.projectId) : null;
    if (project && imageAssetId) {
      const referenceAsset = store.getAsset(imageAssetId);
      const dimensions = imageDimensionsFromReference({ asset: referenceAsset });
      store.updateProject(project.id, {
        config: {
          ...(project.config || {}),
          videoReferenceAssetId: imageAssetId,
          videoReferenceWidth: dimensions?.width ? String(dimensions.width) : project.config?.videoReferenceWidth || "",
          videoReferenceHeight: dimensions?.height ? String(dimensions.height) : project.config?.videoReferenceHeight || "",
          moduleFileName: body.referenceFileName || project.config?.moduleFileName || imageAssetId
        }
      });
    }

    const job = store.createJob({
      id: id("job"),
      type: "video",
      status: "queued",
      model: body.model || projectConfig.videoModel,
      prompt: body.prompt || "",
      projectId: body.projectId || "",
      config: {
        projectId: body.projectId || "",
        aspectRatio,
        resolution,
        duration,
        personGeneration,
        referenceMode,
        videoRoute,
        visionModel: body.visionModel || projectConfig.visionModel,
        videoFallbackModel: projectConfig.videoFallbackModel,
        shotId: body.shotId || "",
        shotIndex: currentShot?.shotIndex || "",
        shotCode: currentShot?.shotId || "",
        shotTitle: currentShot?.title || "",
        imageAssetId,
        referenceAssetIds,
        referenceImageCount: referenceAssetIds.length + (imageUrl ? 1 : 0),
        imageDataUrl: "",
        imageUrl,
        routeOverrides: routeOverridesFromConfig(projectConfig)
      }
    });

    if (body.shotId && currentShot) {
      store.updateShot(body.shotId, {
        videoJobId: job.id,
        status: "video_queued",
        metadata: {
          ...(currentShot.metadata || {}),
          referenceAssetIds
        }
      });
    }

    processVideoJob(job.id);
    sendJson(res, 202, { ok: true, job: publicJob(store.getJob(job.id)) });
    return;
  }

  sendError(res, 404, new Error("API route not found."));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      assertTrustedOrigin(req);
      await handleApi(req, res, url);
      return;
    }

    const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && mediaMatch) {
      const asset = store.getAsset(mediaMatch[1]);
      if (!asset) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const relativeAssetPath = path.relative(ASSETS_DIR, asset.path);
      if (relativeAssetPath.startsWith("..") || path.isAbsolute(relativeAssetPath)) {
        sendError(res, 403, new Error("Asset path is outside the media directory."));
        return;
      }
      serveFile(res, asset.path);
      return;
    }

    let requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeStaticPath(APP_DIR, requestPath);
    serveFile(res, filePath);
  } catch (error) {
    sendError(res, error.status || 500, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gemini Relay Studio console: http://${HOST}:${PORT}`);
  console.log(`OneAPI configured: ${oneapi.isConfigured() ? "yes" : "no"}`);
  console.log(`Host: ${HOST}`);
  console.log(`Config dir: ${CONFIG_DIR}`);
  console.log(`Data dir: ${DATA_DIR}`);
  if (SERVER_LOG_FILE) console.log(`Server log file: ${SERVER_LOG_FILE}`);
  appendServerLog("server.start", `host=${HOST} port=${PORT} configured=${oneapi.isConfigured() ? "yes" : "no"}`);
  appendServerLog("server.path", `config=${CONFIG_DIR} data=${DATA_DIR} log=${SERVER_LOG_FILE || "-"}`);
});

for (const job of store.listActiveVideoJobs()) {
  processVideoJob(job.id);
}
