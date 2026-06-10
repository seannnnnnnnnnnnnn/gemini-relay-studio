const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { envInt } = require("./env");

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/json": "json",
  "text/plain": "txt"
};

function downloadTimeoutMs() {
  const configured = envInt("ASSET_DOWNLOAD_TIMEOUT_MS", 600000);
  return Math.max(configured, 600000);
}

function id(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function extensionForMime(mime) {
  return MIME_EXT[mime] || "bin";
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = isBase64 ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
  return { mime, data };
}

function dataUrlFromFile(filePath, mime) {
  const data = fs.readFileSync(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

function imageDimensionsFromBuffer(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return null;

  if (
    data[0] === 0x89 &&
    data.toString("ascii", 1, 4) === "PNG" &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20)
    };
  }

  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (!length || offset + 2 + length > data.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + length;
    }
  }

  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X" && data.length >= 30) {
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3)
      };
    }
    if (chunk === "VP8L" && data.length >= 25) {
      const bits = data.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      };
    }
  }

  return null;
}

function imageDimensionsFromFile(filePath) {
  try {
    return imageDimensionsFromBuffer(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function imageMetadataFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return {};
  return {
    width: dimensions.width,
    height: dimensions.height,
    orientation: dimensions.width > dimensions.height ? "landscape" : dimensions.height > dimensions.width ? "portrait" : "square"
  };
}

async function bufferFromUrl(url, headers = {}) {
  const timeoutMs = downloadTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Failed to download asset timeout after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(await downloadErrorMessage(response));
    }
    const mime = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    return { mime, data: Buffer.from(await response.arrayBuffer()) };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveUrlToFile(url, filePath, headers = {}) {
  const timeoutMs = downloadTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Failed to download asset timeout after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(await downloadErrorMessage(response));
    }
    const mime = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    if (!response.body) throw new Error("Download response did not include a body.");
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
    return { mime };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadErrorMessage(response) {
  let detail = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const payload = JSON.parse(text);
        detail = payload?.error?.message || payload?.message || text;
      } catch {
        detail = text;
      }
    }
  } catch {
    detail = "";
  }
  return `Failed to download asset ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`;
}

async function saveRemoteOrDataAsset({
  store,
  assetsDir,
  kind,
  value,
  mime,
  prompt,
  model,
  jobId,
  projectId,
  source,
  metadata,
  authHeaders
}) {
  fs.mkdirSync(assetsDir, { recursive: true });

  let payload;
  let originalUrl = "";
  let streamedMime = "";
  if (typeof value === "string" && value.startsWith("data:")) {
    payload = parseDataUrl(value);
  } else if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    originalUrl = value;
    const assetId = id(kind);
    const placeholderMime = mime || (kind === "video" ? "video/mp4" : "application/octet-stream");
    const filename = `${assetId}.${extensionForMime(placeholderMime)}`;
    const filePath = path.join(assetsDir, filename);
    const tempPath = `${filePath}.download`;
    try {
      const firstHeaders = authHeaders && Object.keys(authHeaders).length ? authHeaders : {};
      const secondHeaders = firstHeaders === authHeaders ? {} : authHeaders;
      try {
        const result = await saveUrlToFile(value, tempPath, firstHeaders);
        streamedMime = result.mime;
      } catch (error) {
        if (!secondHeaders || !Object.keys(secondHeaders).length) throw error;
        const result = await saveUrlToFile(value, tempPath, secondHeaders);
        streamedMime = result.mime;
      }
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      throw error;
    }

    return store.createAsset({
      id: assetId,
      kind,
      mime: mime || streamedMime || placeholderMime,
      path: filePath,
      filename,
      source: source || originalUrl,
      prompt,
      model,
      jobId,
      projectId,
      metadata: {
        ...(metadata || {}),
        ...(kind === "image" ? imageMetadataFromDimensions(imageDimensionsFromFile(filePath)) : {}),
        originalUrl
      }
    });
  } else if (Buffer.isBuffer(value)) {
    payload = { mime: mime || "application/octet-stream", data: value };
  } else {
    throw new Error("Unsupported asset payload");
  }

  const assetId = id(kind);
  const finalMime = mime || payload.mime;
  const filename = `${assetId}.${extensionForMime(finalMime)}`;
  const filePath = path.join(assetsDir, filename);
  fs.writeFileSync(filePath, payload.data);

  return store.createAsset({
    id: assetId,
    kind,
    mime: finalMime,
    path: filePath,
    filename,
    source: source || originalUrl,
    prompt,
    model,
    jobId,
    projectId,
    metadata: {
      ...(metadata || {}),
      ...(kind === "image" ? imageMetadataFromDimensions(imageDimensionsFromBuffer(payload.data)) : {}),
      originalUrl
    }
  });
}

module.exports = {
  id,
  extensionForMime,
  parseDataUrl,
  dataUrlFromFile,
  imageDimensionsFromBuffer,
  imageDimensionsFromFile,
  saveRemoteOrDataAsset
};
