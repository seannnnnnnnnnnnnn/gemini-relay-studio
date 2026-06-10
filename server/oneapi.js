const fs = require("node:fs");

const { env, envInt } = require("./env");

const DEFAULT_PATHS = {
  chatPath: "/v1/chat/completions",
  imageChatPath: "/v1/chat/completions",
  videoCreatePath: "/v1/video/generations",
  videoOpenaiCreatePath: "/v1/videos",
  videoPollPaths: "/v1/video/generations/{id},/v1/videos/{id}"
};

function compactObject(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null && entry !== "") out[key] = entry;
  }
  return out;
}

function isFallbackableError(error) {
  if ([400, 404, 405, 422, 500].includes(error.status)) return true;
  const message = String(error.message || error.payload?.error?.message || "").toLowerCase();
  return message.includes("contents is required") || message.includes("not found");
}

function mimeExtension(mime = "") {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("png")) return "png";
  return "bin";
}

function shouldFallbackVideoModel(model, error) {
  if (!/veo-3\.1/i.test(model || "")) return false;
  const message = String(error.message || error.payload?.error?.message || "").toLowerCase();
  return (
    error.status === 404 ||
    error.status === 503 ||
    (error.status === 403 && /余额|额度|quota|insufficient|prepaid|billing/.test(message)) ||
    message.includes("publisher model") ||
    message.includes("does not have access") ||
    message.includes("was not found") ||
    message.includes("no distributor") ||
    message.includes("无可用渠道") ||
    message.includes("no available") ||
    message.includes("quota") ||
    message.includes("prepaid")
  );
}

function fallbackVideoModel(model, config = {}) {
  const configured = config.videoFallbackModel || env("VIDEO_FALLBACK_MODEL");
  if (configured) return configured;
  if (/fast|lite/i.test(model || "")) return "veo-3.0-fast-generate-001";
  return "veo-3.0-generate-001";
}

function dataUrlToBase64(dataUrl) {
  if (!dataUrl) return "";
  return dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
}

function imageInputValue(image) {
  if (!image) return "";
  return image.url || image.dataUrl || "";
}

function uniqueReferenceImages(image, images = []) {
  const refs = [];
  const seen = new Set();
  for (const item of [image, ...(Array.isArray(images) ? images : [])]) {
    if (!item) continue;
    const value = imageInputValue(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    refs.push(item);
  }
  return refs.slice(0, 3);
}

function cleanVideoPrompt(prompt) {
  return String(prompt || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeImageToVideoPrompt(prompt) {
  let safe = cleanVideoPrompt(prompt);

  if (!safe) safe = "保持参考图一致。";

  return [
    "基于参考图生成短视频，保持参考图中的主体身份、性别、年龄感、服装、场景、构图等可见信息一致；不要改写用户指定的人物性别、身份或其他内容。",
    safe
  ].join(" ");
}

function videoPromptForPayload(prompt, imageOrImages) {
  const hasReference = Array.isArray(imageOrImages) ? imageOrImages.length > 0 : Boolean(imageOrImages);
  return hasReference ? sanitizeImageToVideoPrompt(prompt) : cleanVideoPrompt(prompt);
}

function normalizedImageConfig(aspectRatio, imageSize) {
  const ratio = ["16:9", "9:16", "1:1"].includes(String(aspectRatio || "").trim())
    ? String(aspectRatio).trim()
    : "16:9";
  const size = ["1K", "2K", "4K"].includes(String(imageSize || "").toUpperCase())
    ? String(imageSize).toUpperCase()
    : "2K";

  const matrix = {
    "16:9": { "1K": "1280x720", "2K": "2560x1440", "4K": "3840x2160" },
    "9:16": { "1K": "720x1280", "2K": "1440x2560", "4K": "2160x3840" },
    "1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "4096x4096" }
  };
  const pixelSize = matrix[ratio][size];
  const [width, height] = pixelSize.split("x").map((value) => Number.parseInt(value, 10));

  return { aspectRatio: ratio, imageSize: size, pixelSize, width, height };
}

function imagePromptForAspect(prompt, aspectRatio) {
  const normalized = String(prompt || "").trim();
  const ratioHint = aspectRatio === "9:16"
    ? "竖屏构图"
    : aspectRatio === "16:9"
      ? "横屏构图"
      : "方图构图";
  return [
    normalized,
    "",
    `输出约束：最终图片必须是 ${aspectRatio}（${ratioHint}），不要输出其他画幅。`
  ].join("\n").trim();
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    String(error?.message || "").toLowerCase().includes("aborted")
  );
}

function nestedErrorMessage(payload, fallback = "") {
  const candidates = [
    payload?.error?.message,
    payload?.message,
    payload?.data,
    payload?.text,
    fallback
  ];

  for (const candidate of candidates) {
    const parsed = parseMaybeJson(candidate);
    if (parsed && typeof parsed === "object") {
      const nested = nestedErrorMessage(parsed);
      if (nested) return nested;
    }
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  }
  return "";
}

function stripWrappedQuotes(text) {
  let out = String(text || "").trim();
  for (;;) {
    const next = out
      .replace(/^["'`“”‘’]+/, "")
      .replace(/["'`“”‘’]+$/, "")
      .trim();
    if (next === out) return out;
    out = next;
  }
}

function sanitizeApiKey(raw) {
  let key = stripWrappedQuotes(raw);
  key = key.replace(/^authorization\s*:\s*/i, "").trim();
  key = key.replace(/^bearer\s+/i, "").trim();
  return stripWrappedQuotes(key);
}

function normalizeBaseUrl(baseUrl) {
  const raw = stripWrappedQuotes(baseUrl);
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    let pathname = (parsed.pathname || "").replace(/\/+$/, "");
    const lowerPath = pathname.toLowerCase();

    // Common New-API panel routes should not be used as API base paths.
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
    return raw.replace(/\/+$/, "");
  }
}

function joinUrl(baseUrl, apiPath) {
  if (/^https?:\/\//i.test(apiPath)) return apiPath;
  const cleanBase = normalizeBaseUrl(baseUrl);
  let cleanPath = String(apiPath || "");
  if (!cleanPath.startsWith("/")) cleanPath = `/${cleanPath}`;
  cleanPath = cleanPath.replace(/\/+/g, "/");
  cleanPath = cleanPath.replace(/^\/v1beta\/v1\//, "/v1/");
  cleanPath = cleanPath.replace(/^\/v1\/v1\//, "/v1/");
  return `${cleanBase}${cleanPath}`;
}

function normalizeApiPath(raw, fallback) {
  let value = stripWrappedQuotes(raw);
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

function looksLikeHtmlDocument(text) {
  const head = String(text || "").slice(0, 1600).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

function apiHtmlMisrouteError(text) {
  if (!looksLikeHtmlDocument(text)) return null;
  const head = String(text || "").slice(0, 2400);
  const isNewApiConsole = /new-api|<div id="root">|统一的ai模型聚合|您需要启用 javascript/i.test(head);
  const prefix = isNewApiConsole
    ? "检测到 New API 控制台页面 HTML。"
    : "检测到 HTML 页面响应（非 API JSON）。";
  const error = new Error(
    `${prefix} 当前 OneAPI 地址或网关路由指向了网页而不是接口。请把 OneAPI 地址设置为 API 根地址，并确保 /v1/chat/completions 可访问。`
  );
  error.status = 502;
  return error;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part.text || part.output_text || part.content || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractText(response) {
  const choice = response?.choices?.[0];
  const messageText = contentToText(choice?.message?.content);
  if (messageText) return messageText;

  const outputText = contentToText(response?.output_text);
  if (outputText) return outputText;

  const candidates = response?.candidates || [];
  const candidateText = candidates
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n");
  if (candidateText) return candidateText;

  return typeof response === "string" ? response : JSON.stringify(response, null, 2);
}

function guessMimeFromUrl(url, fallback = "application/octet-stream") {
  const clean = String(url).split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".mp4")) return "video/mp4";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  return fallback;
}

function uniqueMedia(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = item.dataUrl || item.url;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(item);
  }
  return out;
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  for (const item of Object.values(value)) walk(item, visit, seen);
}

function extractImages(response) {
  const images = [];

  walk(response, (node) => {
    const inlineData = node.inlineData || node.inline_data;
    if (inlineData?.data) {
      const mime = inlineData.mimeType || inlineData.mime_type || "image/png";
      if (String(mime).startsWith("image/")) {
        images.push({ dataUrl: `data:${mime};base64,${inlineData.data}`, mime, source: "inlineData" });
      }
    }

    if (node.b64_json && !node.mime) {
      images.push({ dataUrl: `data:image/png;base64,${node.b64_json}`, mime: "image/png", source: "b64_json" });
    }

    const imageBytes = node.imageBytes || node.image_bytes;
    if (imageBytes) {
      const mime = node.mimeType || node.mime_type || "image/png";
      images.push({ dataUrl: `data:${mime};base64,${imageBytes}`, mime, source: "imageBytes" });
    }

    const maybeUrl = node.url || node.uri || node.image_url?.url || node.imageUrl?.url;
    if (typeof maybeUrl === "string") {
      if (maybeUrl.startsWith("data:image/")) {
        const mime = /^data:([^;,]+)/.exec(maybeUrl)?.[1] || "image/png";
        images.push({ dataUrl: maybeUrl, mime, source: "dataUrl" });
      } else if (/^https?:\/\//i.test(maybeUrl) && /\.(png|jpe?g|webp|heic|heif)(\?|$)/i.test(maybeUrl)) {
        images.push({ url: maybeUrl, mime: guessMimeFromUrl(maybeUrl, "image/png"), source: "url" });
      }
    }
  });

  const text = JSON.stringify(response);
  for (const match of text.matchAll(/data:(image\/[^;,"]+);base64,([A-Za-z0-9+/=]+)/g)) {
    images.push({ dataUrl: `data:${match[1]};base64,${match[2]}`, mime: match[1], source: "embeddedDataUrl" });
  }
  for (const match of text.matchAll(/https?:\/\/[^"'\s)]+?\.(?:png|jpe?g|webp|heic|heif)(?:\?[^"'\s)]*)?/gi)) {
    images.push({ url: match[0], mime: guessMimeFromUrl(match[0], "image/png"), source: "embeddedUrl" });
  }

  return uniqueMedia(images);
}

function extractVideos(response) {
  const videos = [];

  walk(response, (node) => {
    const openAiVideoId = node.task_id || node.id;
    if (
      ["completed", "succeeded"].includes(String(node.status || "").toLowerCase()) &&
      typeof openAiVideoId === "string" &&
      (node.object === "video" || node.progress === 100) &&
      !node.url
    ) {
      videos.push({
        url: `/v1/videos/${encodeURIComponent(openAiVideoId)}/content`,
        mime: "video/mp4",
        source: "openaiVideoContent"
      });
    }

    if (
      node.status === "succeeded" &&
      typeof node.task_id === "string" &&
      (node.url === "" || node.url === undefined) &&
      (node.format === "mp4" || node.object === "video")
    ) {
      videos.push({
        url: `/v1/videos/${encodeURIComponent(node.task_id)}/content`,
        mime: "video/mp4",
        source: "taskContent"
      });
    }

    const parentVideoUri = node.video?.url || node.video?.uri || node.video?.fileUri || node.video?.file_uri;
    if (typeof parentVideoUri === "string") {
      videos.push({
        url: parentVideoUri,
        mime: guessMimeFromUrl(parentVideoUri, "video/mp4"),
        source: "videoObject"
      });
    }

    const maybeUrl =
      node.url ||
      node.uri ||
      node.fileUri ||
      node.file_uri ||
      node.downloadUrl ||
      node.download_url ||
      node.video?.url ||
      node.video?.uri ||
      node.video?.fileUri ||
      node.video?.file_uri;

    if (typeof maybeUrl === "string") {
      if (maybeUrl.startsWith("data:video/")) {
        const mime = /^data:([^;,]+)/.exec(maybeUrl)?.[1] || "video/mp4";
        videos.push({ dataUrl: maybeUrl, mime, source: "dataUrl" });
      } else if (
        /^https?:\/\//i.test(maybeUrl) &&
        (/\.(mp4|webm|mov)(\?|$)/i.test(maybeUrl) ||
          /\/v1\/videos\/[^/]+\/content(?:\?|$)/i.test(maybeUrl) ||
          /\/files\//i.test(maybeUrl) ||
          /:download/i.test(maybeUrl) ||
          String(node.mimeType || node.mime_type || "").startsWith("video/"))
      ) {
        videos.push({ url: maybeUrl, mime: guessMimeFromUrl(maybeUrl, "video/mp4"), source: "url" });
      }
    }

    const bytes = node.videoBytes || node.video_bytes || node.bytesBase64Encoded;
    if (bytes) {
      const mime = node.mimeType || node.mime_type || "video/mp4";
      if (String(mime).startsWith("video/")) {
        videos.push({ dataUrl: `data:${mime};base64,${bytes}`, mime, source: "videoBytes" });
      }
    }
  });

  const text = JSON.stringify(response);
  for (const match of text.matchAll(/data:(video\/[^;,"]+);base64,([A-Za-z0-9+/=]+)/g)) {
    videos.push({ dataUrl: `data:${match[1]};base64,${match[2]}`, mime: match[1], source: "embeddedDataUrl" });
  }
  for (const match of text.matchAll(/https?:\/\/[^"'\s)]+?(?:\.(?:mp4|webm|mov)|\/v1\/videos\/[^/"'\s)]+\/content)(?:\?[^"'\s)]*)?/gi)) {
    videos.push({ url: match[0], mime: guessMimeFromUrl(match[0], "video/mp4"), source: "embeddedUrl" });
  }

  return uniqueMedia(videos);
}

function imageForGemini(image) {
  if (!image?.dataUrl) return undefined;
  return {
    inlineData: {
      mimeType: image.mime || "image/png",
      data: image.dataUrl.split(",")[1] || image.dataUrl
    }
  };
}

function chatImagePart(image) {
  const url = imageInputValue(image);
  if (!url) return null;
  return { type: "image_url", image_url: { url } };
}

function normalizedVideoConfig(config = {}) {
  const resolution = config.resolution || "720p";
  const normalizedResolution = String(resolution || "").toLowerCase();
  let durationSeconds = String(config.duration || "").trim();
  const hasReference = Boolean(
    config.imageAssetId ||
      config.imageDataUrl ||
      config.imageUrl ||
      config.referenceImageCount ||
      (Array.isArray(config.referenceAssetIds) && config.referenceAssetIds.length) ||
      (Array.isArray(config.referenceImages) && config.referenceImages.length) ||
      config.compatibleImageToVideo
  );
  if (!["4", "6", "8"].includes(durationSeconds)) durationSeconds = "";
  if (hasReference) durationSeconds = "8";
  if (["1080p", "4k"].includes(normalizedResolution)) durationSeconds = "8";
  const aspectRatio = config.aspectRatio || "16:9";
  const sizeMatrix = {
    "16:9": {
      "720p": { width: 1280, height: 720 },
      "1080p": { width: 1920, height: 1080 },
      "4k": { width: 3840, height: 2160 }
    },
    "9:16": {
      "720p": { width: 720, height: 1280 },
      "1080p": { width: 1080, height: 1920 },
      "4k": { width: 2160, height: 3840 }
    }
  };
  const size = sizeMatrix[aspectRatio]?.[normalizedResolution] || sizeMatrix[aspectRatio]?.["720p"] || sizeMatrix["16:9"]["720p"];

  return {
    aspectRatio,
    resolution,
    durationSeconds: durationSeconds ? Number(durationSeconds) : undefined,
    width: size.width,
    height: size.height,
    personGeneration: config.personGeneration || "",
    sampleCount: 1
  };
}

function operationId(response) {
  return (
    response?.id ||
    response?.name ||
    response?.operation?.name ||
    response?.operationName ||
    response?.task_id ||
    response?.taskId ||
    response?.job_id ||
    response?.jobId ||
    response?.video_id ||
    response?.videoId ||
    response?.data?.task_id ||
    response?.data?.taskId ||
    response?.data?.id ||
    response?.data?.[0]?.id ||
    ""
  );
}

function operationStatus(response) {
  const raw =
    response?.status ||
    response?.state ||
    response?.operation?.status ||
    response?.data?.status ||
    response?.data?.state ||
    response?.data?.[0]?.status ||
    "";
  return String(raw).toLowerCase();
}

function isDone(response) {
  if (response?.done === true) return true;
  const status = operationStatus(response);
  return ["done", "completed", "complete", "succeeded", "success", "finished"].includes(status);
}

function isFailed(response) {
  const status = operationStatus(response);
  return (
    ["failed", "failure", "error", "cancelled", "canceled"].includes(status) ||
    Boolean(response?.error) ||
    Boolean(response?.data?.error)
  );
}

async function imageToBlob(image) {
  if (!image) return null;
  const mime = image.mime || "image/png";

  if (image.asset?.path) {
    return {
      blob: new Blob([fs.readFileSync(image.asset.path)], { type: mime }),
      filename: image.asset.filename || `reference.${mimeExtension(mime)}`
    };
  }

  if (image.dataUrl) {
    const data = dataUrlToBase64(image.dataUrl);
    return {
      blob: new Blob([Buffer.from(data, "base64")], { type: mime }),
      filename: `reference.${mimeExtension(mime)}`
    };
  }

  if (image.url) {
    const controller = new AbortController();
    const timeoutMs = envInt("IMAGE_REQUEST_TIMEOUT_MS", envInt("REQUEST_TIMEOUT_MS", 120000));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetch(image.url, { signal: controller.signal });
      } catch (error) {
        if (isAbortError(error)) {
          const timeoutError = new Error(`Image reference download timed out after ${Math.round(timeoutMs / 1000)}s.`);
          timeoutError.status = 408;
          throw timeoutError;
        }
        throw error;
      }
      if (!response.ok) throw new Error(`Failed to fetch image URL ${response.status} ${response.statusText}`);
      const remoteMime = response.headers.get("content-type")?.split(";")[0] || mime;
      return {
        blob: new Blob([Buffer.from(await response.arrayBuffer())], { type: remoteMime }),
        filename: `reference.${mimeExtension(remoteMime)}`
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

class OneApiClient {
  constructor(overrides = {}) {
    this.overrides = { ...overrides };
    this.reload();
  }

  reload(overrides = null) {
    if (overrides) this.overrides = { ...this.overrides, ...overrides };
    this.baseUrl = normalizeBaseUrl(stripWrappedQuotes(this.overrides.baseUrl || env("ONEAPI_BASE_URL", "https://oneapi.keath.ai")));
    this.apiKey = sanitizeApiKey(this.overrides.apiKey || env("ONEAPI_API_KEY"));
    this.timeoutMs = envInt("REQUEST_TIMEOUT_MS", 120000);
    this.imageTimeoutMs = envInt("IMAGE_REQUEST_TIMEOUT_MS", Math.max(this.timeoutMs, 300000));
    this.chatPath = normalizeApiPath(this.overrides.chatPath || env("OPENAI_CHAT_PATH", DEFAULT_PATHS.chatPath), DEFAULT_PATHS.chatPath);
    this.imageChatPath = normalizeApiPath(this.overrides.imageChatPath || env("IMAGE_CHAT_PATH", DEFAULT_PATHS.imageChatPath), DEFAULT_PATHS.imageChatPath);
    this.videoCreatePath = normalizeApiPath(this.overrides.videoCreatePath || env("VIDEO_CREATE_PATH", DEFAULT_PATHS.videoCreatePath), DEFAULT_PATHS.videoCreatePath);
    this.videoOpenaiCreatePath = normalizeApiPath(this.overrides.videoOpenaiCreatePath || env("VIDEO_OPENAI_CREATE_PATH", DEFAULT_PATHS.videoOpenaiCreatePath), DEFAULT_PATHS.videoOpenaiCreatePath);
    this.videoPollPaths = normalizePollPaths(this.overrides.videoPollPaths || env("VIDEO_POLL_PATHS", DEFAULT_PATHS.videoPollPaths));
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && !this.apiKey.includes("your-key"));
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  async request(apiPath, { method = "GET", body, signal, headers = {}, timeoutMs } = {}) {
    if (!this.isConfigured()) {
      throw new Error("ONEAPI_API_KEY is not configured. Copy .env.example to .env and fill it in.");
    }

    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    const requestSignal = signal || controller.signal;

    try {
      let response;
      try {
        response = await fetch(joinUrl(this.baseUrl, apiPath), {
          method,
          signal: requestSignal,
          headers: {
            ...this.authHeaders(),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...headers
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch (error) {
        if (isAbortError(error)) {
          const timeoutError = new Error(`Request timed out after ${Math.round(effectiveTimeoutMs / 1000)}s.`);
          timeoutError.status = 408;
          throw timeoutError;
        }
        throw error;
      }

      const text = await response.text();
      const htmlError = apiHtmlMisrouteError(text);
      if (htmlError) {
        htmlError.payload = { text };
        throw htmlError;
      }
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { text };
      }

      if (!response.ok) {
        const message = nestedErrorMessage(payload, text) || response.statusText;
        const isInvalidToken = response.status === 401 && /invalid token|无效令牌/i.test(message);
        const hint = isInvalidToken
          ? "（请在接口配置里重新粘贴纯 API Key：不要带 Bearer、不要带 Authorization:、不要带引号）"
          : "";
        const error = new Error(`OneAPI ${response.status}: ${message}${hint}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      const nestedHtmlError = apiHtmlMisrouteError(payload?.text);
      if (nestedHtmlError) {
        nestedHtmlError.payload = payload;
        throw nestedHtmlError;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestForm(apiPath, form, { method = "POST", headers = {}, timeoutMs } = {}) {
    if (!this.isConfigured()) {
      throw new Error("ONEAPI_API_KEY is not configured. Copy .env.example to .env and fill it in.");
    }

    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      let response;
      try {
        response = await fetch(joinUrl(this.baseUrl, apiPath), {
        method,
        signal: controller.signal,
        headers: {
          ...this.authHeaders(),
          ...headers
        },
        body: form
      });
      } catch (error) {
        if (isAbortError(error)) {
          const timeoutError = new Error(`Request timed out after ${Math.round(effectiveTimeoutMs / 1000)}s.`);
          timeoutError.status = 408;
          throw timeoutError;
        }
        throw error;
      }

      const text = await response.text();
      const htmlError = apiHtmlMisrouteError(text);
      if (htmlError) {
        htmlError.payload = { text };
        throw htmlError;
      }
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { text };
      }

      if (!response.ok) {
        const message = nestedErrorMessage(payload, text) || response.statusText;
        const isInvalidToken = response.status === 401 && /invalid token|无效令牌/i.test(message);
        const hint = isInvalidToken
          ? "（请在接口配置里重新粘贴纯 API Key：不要带 Bearer、不要带 Authorization:、不要带引号）"
          : "";
        const error = new Error(`OneAPI ${response.status}: ${message}${hint}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      const nestedHtmlError = apiHtmlMisrouteError(payload?.text);
      if (nestedHtmlError) {
        nestedHtmlError.payload = payload;
        throw nestedHtmlError;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateText({ model, prompt, system, temperature, maxTokens }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const payload = compactObject({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false
    });

    const response = await this.request(this.chatPath, {
      method: "POST",
      body: payload
    });

    return {
      text: extractText(response),
      raw: response
    };
  }

  async describeImageForVideo({ model, prompt, image }) {
    const imagePart = chatImagePart(image);
    if (!imagePart) throw new Error("Image reference is required for compatible image-to-video mode.");

    // If the client sends a rich prompt (e.g. from videoPromptAnalysisPrompt), use it directly.
    // Only wrap in the default template when prompt is short/empty (legacy or simple action hint).
    const isRichPrompt = prompt && prompt.length > 120;
    const analysisPrompt = isRichPrompt
      ? prompt
      : [
          "你是 AI 视频分镜师。请阅读这张首帧图，为 Veo 文生视频生成一个稳定的视觉参考描述。",
          "只输出中文，不要 Markdown，不要解释任务。",
          "描述必须包含：主体、性别、年龄感/身份感、服装、场景、构图、镜头距离、光线、色彩。",
          "如实描述可见内容，不要把用户或画面中的性别、年龄感、身份改写成中性或默认描述。",
          "",
          "用户动作需求：",
          prompt || "保持参考图一致。"
        ].join("\n");

    const models = [
      model,
      env("VISION_MODEL", "gemini-3.1-pro-preview"),
      env("IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
      "gemini-3.1-flash-image-preview"
    ].filter((value, index, list) => value && list.indexOf(value) === index);

    let response;
    let lastError;
    for (const attemptModel of models) {
      try {
        response = await this.request(this.chatPath, {
          method: "POST",
          body: compactObject({
            model: attemptModel,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: analysisPrompt },
                  imagePart
                ]
              }
            ],
            temperature: 0.2,
            max_tokens: isRichPrompt ? 1200 : 900,
            stream: false
          })
        });
        break;
      } catch (error) {
        lastError = error;
        if (![400, 404, 405, 422, 500].includes(error.status)) break;
      }
    }

    if (!response) throw lastError || new Error("Failed to describe image reference.");

    return {
      text: extractText(response),
      raw: response
    };
  }

  async generateImage({ model, prompt, inputImages = [], aspectRatio, imageSize }) {
    const chatPath = this.imageChatPath;
    const config = normalizedImageConfig(aspectRatio, imageSize);
    const promptWithAspect = imagePromptForAspect(prompt, config.aspectRatio);
    const content = [{ type: "text", text: promptWithAspect }];
    for (const image of inputImages) {
      const url = imageInputValue(image);
      if (url) content.push({ type: "image_url", image_url: { url } });
    }

    const richPayload = compactObject({
      model,
      messages: [{ role: "user", content: content.length > 1 ? content : promptWithAspect }],
      modalities: ["text", "image"],
      response_modalities: ["TEXT", "IMAGE"],
      image_config: compactObject({
        aspect_ratio: config.aspectRatio,
        image_size: config.imageSize
      }),
      aspect_ratio: config.aspectRatio,
      size: config.pixelSize,
      width: config.width,
      height: config.height,
      stream: false
    });

    const compatPayload = compactObject({
      model,
      messages: [{ role: "user", content: content.length > 1 ? content : promptWithAspect }],
      image_config: compactObject({
        aspect_ratio: config.aspectRatio,
        image_size: config.imageSize
      }),
      aspect_ratio: config.aspectRatio,
      size: config.pixelSize,
      width: config.width,
      height: config.height,
      stream: false
    });

    const attempts = [
      () => this.request(chatPath, { method: "POST", body: richPayload, timeoutMs: this.imageTimeoutMs }),
      () =>
        this.request(chatPath, {
          method: "POST",
          body: compatPayload,
          timeoutMs: this.imageTimeoutMs
        }),
      () =>
        this.request(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          body: {
            contents: [
              {
                parts: [
                  { text: promptWithAspect },
                  ...inputImages.map((image) => ({
                    inlineData: {
                      mimeType: image.mime || "image/png",
                      data: image.dataUrl.split(",")[1] || image.dataUrl
                    }
                  }))
                ]
              }
            ],
            generationConfig: compactObject({
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: compactObject({
                aspectRatio: config.aspectRatio,
                imageSize: config.imageSize
              })
            })
          },
          timeoutMs: this.imageTimeoutMs
        })
    ];

    let lastError;
    for (const attempt of attempts) {
      try {
        const response = await attempt();
        return {
          images: extractImages(response),
          text: extractText(response),
          raw: response
        };
      } catch (error) {
        lastError = error;
        if (![400, 404, 405, 422].includes(error.status)) break;
      }
    }
    throw lastError;
  }

  videoPayload({ model, prompt, image, images = [], config = {} }) {
    const videoConfig = normalizedVideoConfig(config);
    const refs = uniqueReferenceImages(image, images);
    const safePrompt = videoPromptForPayload(prompt, refs);
    return compactObject({
      model,
      prompt: safePrompt,
      image: refs[0]?.url || (refs[0]?.dataUrl ? dataUrlToBase64(refs[0].dataUrl) : undefined),
      referenceImages: refs.map((ref) => ({
        image: compactObject({
          bytesBase64Encoded: ref.dataUrl ? dataUrlToBase64(ref.dataUrl) : undefined,
          gcsUri: ref.gcsUri,
          uri: ref.url,
          mimeType: ref.mime || "image/png"
        }),
        referenceType: "asset"
      })),
      duration: refs.length ? 8 : videoConfig.durationSeconds,
      width: videoConfig.width,
      height: videoConfig.height,
      n: 1,
      metadata: compactObject({
        aspect_ratio: videoConfig.aspectRatio,
        aspectRatio: videoConfig.aspectRatio,
        resolution: videoConfig.resolution,
        original_prompt: refs.length && safePrompt !== prompt ? prompt : undefined,
        prompt_sanitized: refs.length && safePrompt !== prompt ? true : undefined,
        reference_image_count: refs.length,
        image_mime: refs[0]?.mime,
        image_source: refs[0]?.url ? "url" : refs[0]?.dataUrl ? "base64" : undefined,
        person_generation: videoConfig.personGeneration,
        personGeneration: videoConfig.personGeneration
      })
    });
  }

  async startVideo({ model, prompt, image, images = [], config = {} }) {
    const createPath = this.videoCreatePath;
    let lastError;

    const primaryModel = model || env("VIDEO_MODEL", "veo-3.0-generate-001");
    const models = [primaryModel];
    const fallback = fallbackVideoModel(primaryModel, config);
    if (fallback && fallback !== primaryModel) models.push(fallback);

    for (const attemptModel of models) {
      try {
        const response = await this.request(createPath, {
          method: "POST",
          body: this.videoPayload({ model: attemptModel, prompt, image, images, config })
        });
        return this.videoState(response, {
          model: attemptModel,
          requestedModel: primaryModel,
          fallbackFrom: attemptModel === primaryModel ? "" : primaryModel
        });
      } catch (error) {
        lastError = error;
        if (!shouldFallbackVideoModel(attemptModel, error)) break;
      }
    }
    throw lastError;
  }

  async startVideoMultipart({ model, prompt, image, images = [], config = {} }) {
    const createPath = this.videoOpenaiCreatePath;
    const primaryModel = model || env("VIDEO_MODEL", "veo-3.1-generate-001");
    const models = [primaryModel];
    const fallback = fallbackVideoModel(primaryModel, config);
    if (fallback && fallback !== primaryModel) models.push(fallback);

    const videoConfig = normalizedVideoConfig(config);
    const refs = uniqueReferenceImages(image, images);
    const safePrompt = videoPromptForPayload(prompt, refs);
    const imageFiles = [];
    for (const ref of refs) {
      const file = await imageToBlob(ref);
      if (file) imageFiles.push({ ...file, mime: ref.mime || file.blob.type || "image/png" });
    }
    let lastError;

    for (const attemptModel of models) {
      const form = new FormData();
      form.append("model", attemptModel);
      form.append("prompt", safePrompt);
      form.append("seconds", String(imageFiles.length ? 8 : (videoConfig.durationSeconds || 8)));
      form.append("size", `${videoConfig.width}x${videoConfig.height}`);
      if (videoConfig.aspectRatio) form.append("aspect_ratio", videoConfig.aspectRatio);
      if (videoConfig.resolution) form.append("resolution", videoConfig.resolution);
      if (videoConfig.personGeneration) form.append("personGeneration", videoConfig.personGeneration);
      if (imageFiles.length) {
        form.append("reference_images", JSON.stringify(imageFiles.map((file) => ({
          mimeType: file.mime,
          referenceType: "asset"
        }))));
      }
      for (const file of imageFiles) {
        form.append("input_reference", file.blob, file.filename);
      }

      try {
        const response = await this.requestForm(createPath, form);
        return this.videoState(response, {
          model: attemptModel,
          requestedModel: primaryModel,
          fallbackFrom: attemptModel === primaryModel ? "" : primaryModel,
          route: "openai_multipart"
        });
      } catch (error) {
        lastError = error;
        if (!shouldFallbackVideoModel(attemptModel, error)) break;
      }
    }
    throw lastError;
  }

  videoState(response, meta = {}) {
    return {
      done: isDone(response) || extractVideos(response).length > 0,
      failed: isFailed(response),
      status: operationStatus(response),
      remoteId: operationId(response),
      videos: extractVideos(response),
      model: meta.model || response?.model || "",
      requestedModel: meta.requestedModel || "",
      fallbackFrom: meta.fallbackFrom || "",
      route: meta.route || "",
      raw: response
    };
  }

  async pollVideo(remoteId, options = {}) {
    const safeId = encodeURIComponent(remoteId);
    const paths = [];

    if (options.route === "openai_multipart") {
      paths.push(`/v1/videos/${safeId}`);
    }

    if (/^(operations|models)\//.test(remoteId)) {
      paths.push(`/v1beta/${remoteId}`);
    }

    const pollPathList = this.videoPollPaths;
    for (const pattern of pollPathList.split(",")) {
      const trimmed = pattern.trim();
      if (trimmed) paths.push(trimmed.replaceAll("{id}", safeId));
    }

    let lastError;
    for (const apiPath of paths) {
      try {
        const response = await this.request(apiPath, { method: "GET" });
        return this.videoState(response);
      } catch (error) {
        lastError = error;
        if (![404, 405].includes(error.status)) break;
      }
    }
    throw lastError || new Error("No video polling path configured.");
  }
}

module.exports = { OneApiClient, extractImages, extractVideos };
