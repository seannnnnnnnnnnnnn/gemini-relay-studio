import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Bot,
  ChevronRight,
  CirclePlus,
  Download,
  Film,
  History,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  MoreVertical,
  PlugZap,
  RefreshCw,
  Save,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Upload,
  WandSparkles,
  Zap
} from "lucide-react";

const MODULES = {
  text: {
    id: "text",
    label: "文本",
    title: "文本生成",
    subtitle: "单点生成、保存项目、历史二次编辑",
    icon: MessageSquareText,
    jobType: "text",
    projectPrefix: "文本项目",
    accent: "moss"
  },
  image: {
    id: "image",
    label: "图片",
    title: "图片生成",
    subtitle: "独立提示词、可上传参考图、结果可下载",
    icon: ImageIcon,
    jobType: "image",
    projectPrefix: "图片项目",
    accent: "ember"
  },
  video: {
    id: "video",
    label: "视频",
    title: "视频生成",
    subtitle: "文生视频或参考图生视频，后台轮询保存",
    icon: Film,
    jobType: "video",
    projectPrefix: "视频项目",
    accent: "iris"
  }
};

const MODULE_ORDER = ["text", "image", "video"];
const DEFAULT_ROUTES = {
  chatPath: "/v1/chat/completions",
  imageChatPath: "/v1/chat/completions",
  videoCreatePath: "/v1/video/generations",
  videoOpenaiCreatePath: "/v1/videos",
  videoPollPaths: "/v1/video/generations/{id},/v1/videos/{id}"
};
const VIDEO_DURATION_OPTIONS = ["4", "6", "8"];

function hasVideoReference(form = {}) {
  return Boolean(form.referenceDataUrl || form.referenceAssetId || String(form.referenceUrl || "").trim());
}

function referenceDimensions(form = {}) {
  const width = Number(form.referenceWidth || 0);
  const height = Number(form.referenceHeight || 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

function referenceOrientationFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return "";
  if (dimensions.width > dimensions.height * 1.08) return "landscape";
  if (dimensions.height > dimensions.width * 1.08) return "portrait";
  return "square";
}

function videoDurationOptions(form = {}) {
  const resolution = String(form.resolution || "").toLowerCase();
  return resolution === "1080p" || resolution === "4k" || hasVideoReference(form)
    ? ["8"]
    : VIDEO_DURATION_OPTIONS;
}

function videoDurationConstraintReason(form = {}) {
  const duration = String(form.duration || "");
  const resolution = String(form.resolution || "").toLowerCase();
  const aspectRatio = String(form.aspectRatio || "");
  const referenceOrientation = referenceOrientationFromDimensions(referenceDimensions(form));
  if (hasVideoReference(form) && referenceOrientation === "portrait" && aspectRatio === "16:9") {
    return "参考图是竖图，请选择 9:16 或上传横图后再生成。";
  }
  if (hasVideoReference(form) && referenceOrientation === "landscape" && aspectRatio === "9:16") {
    return "参考图是横图，请选择 16:9 或上传竖图后再生成。";
  }
  if (hasVideoReference(form) && aspectRatio === "9:16" && resolution !== "720p") {
    return "当前中转站的竖屏参考图生视频只支持 720p。";
  }
  if (hasVideoReference(form) && duration !== "8") {
    return "上传参考图或填写参考图 URL 后，图生视频只支持 8 秒。";
  }
  if ((resolution === "1080p" || resolution === "4k") && duration !== "8") {
    return "1080p 和 4K 视频只支持 8 秒。";
  }
  if (duration && !VIDEO_DURATION_OPTIONS.includes(duration)) {
    return "当前视频模型只支持 4、6 或 8 秒。";
  }
  return "";
}

function videoDurationLockHint(form = {}) {
  const resolution = String(form.resolution || "").toLowerCase();
  if (hasVideoReference(form)) return "已上传参考图，时长锁定为 8 秒。";
  if (resolution === "1080p" || resolution === "4k") return "当前清晰度只支持 8 秒。";
  return "";
}

function videoResolutionOptions(form = {}) {
  return hasVideoReference(form) && form.aspectRatio === "9:16"
    ? ["720p"]
    : ["720p", "1080p", "4k"];
}

function videoResolutionLockHint(form = {}) {
  return hasVideoReference(form) && form.aspectRatio === "9:16"
    ? "竖屏参考图生视频已锁定 720p。"
    : "";
}

function emptyForms() {
  return {
    text: {
      projectName: "",
      description: "",
      model: "",
      system: "你是一个可靠的中文创作助手，回答清晰、结构紧凑。",
      prompt: "",
      output: "",
      resultJobId: "",
      temperature: "0.72",
      maxTokens: "",
      fileName: ""
    },
    image: {
      projectName: "",
      description: "",
      model: "",
      prompt: "",
      negativePrompt: "",
      aspectRatio: "16:9",
      imageSize: "2K",
      referenceDataUrl: "",
      referenceFileName: "",
      resultAssetId: ""
    },
    video: {
      projectName: "",
      description: "",
      model: "",
      prompt: "",
      aspectRatio: "16:9",
      resolution: "720p",
      duration: "8",
      referenceMode: "native_multipart",
      referenceDataUrl: "",
      referenceAssetId: "",
      referenceWidth: "",
      referenceHeight: "",
      referenceFileName: "",
      referenceUrl: "",
      resultJobId: "",
      resultAssetId: ""
    }
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

function cx(...values) {
  return values.filter(Boolean).join(" ");
}

function stamp() {
  return new Date()
    .toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
    .replace(/\//g, "-");
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function preview(text, length = 80) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "暂无内容";
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageInfoFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    image.onerror = () => resolve({});
    image.src = dataUrl;
  });
}

function downloadBlob(text, filename, mime = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadUrl(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "";
  anchor.click();
}

function firstModel(settings, catalog, key, fallback = "") {
  return settings?.models?.[key] || catalog?.[key.replace("Model", "")]?.[0] || fallback;
}

function moduleFromProject(project) {
  const moduleId = project?.config?.appModule;
  return MODULES[moduleId] ? moduleId : "";
}

function assetTitle(asset) {
  return asset?.metadata?.title || asset?.filename || asset?.id || "素材";
}

function assetKindLabel(kind) {
  if (kind === "video") return "视频";
  if (kind === "image") return "图片";
  if (kind === "text") return "文本";
  return "素材";
}

function assetDimensions(asset) {
  const width = asset?.metadata?.width;
  const height = asset?.metadata?.height;
  return width && height ? `${width} x ${height}` : "";
}

function compactValue(value, fallback = "未设置") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function splitImagePromptParts(value) {
  const promptLines = [];
  const negativeLines = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = /^避免[:：]\s*(.*)$/.exec(line.trim());
    if (match) {
      if (match[1]) negativeLines.push(match[1]);
      continue;
    }
    promptLines.push(line);
  }
  return {
    prompt: promptLines.join("\n").trim(),
    negativePrompt: negativeLines.join("\n").trim()
  };
}

function assetIdFromJob(job, assets, kind = "") {
  const ids = [];
  const addId = (value) => {
    if (value && !ids.includes(value)) ids.push(value);
  };

  addId(job?.assetId);
  addId(job?.result?.asset?.id);
  for (const asset of Array.isArray(job?.result?.assets) ? job.result.assets : []) {
    addId(asset?.id);
  }

  const byId = ids
    .map((assetId) => assets.find((asset) => asset.id === assetId && (!kind || asset.kind === kind)))
    .find(Boolean);
  if (byId) return byId.id;

  return assets.find((asset) => asset.jobId === job?.id && (!kind || asset.kind === kind))?.id || "";
}

function resultSelection(form = {}, jobs = [], assets = [], kind = "") {
  const selectedJob = form.resultJobId ? jobs.find((job) => job.id === form.resultJobId) : null;
  const resultJob = selectedJob || (!form.resultJobId ? jobs[0] : null);
  const explicitAsset = form.resultAssetId
    ? assets.find((asset) => asset.id === form.resultAssetId && (!kind || asset.kind === kind))
    : null;
  if (explicitAsset) return { resultJob, resultAsset: explicitAsset };

  const jobAssetId = assetIdFromJob(resultJob, assets, kind);
  const jobAsset = jobAssetId ? assets.find((asset) => asset.id === jobAssetId) : null;
  const fallbackAsset = !form.resultJobId && !form.resultAssetId
    ? assets.find((asset) => !kind || asset.kind === kind)
    : null;

  return { resultJob, resultAsset: jobAsset || fallbackAsset || null };
}

function projectVideoReferenceAsset(project = null, assets = []) {
  if (!project?.id) return null;
  return assets.find((asset) => (
    asset.projectId === project.id &&
    asset.kind === "image" &&
    asset.source === "video-reference"
  )) || null;
}

export default function App() {
  const [activeModule, setActiveModule] = useState("text");
  const [activeTab, setActiveTab] = useState("workbench");
  const [forms, setForms] = useState(emptyForms);
  const [selectedProjectIds, setSelectedProjectIds] = useState({});
  const [settings, setSettings] = useState(null);
  const [health, setHealth] = useState(null);
  const [models, setModels] = useState({ text: [], image: [], video: [] });
  const [projects, setProjects] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [assets, setAssets] = useState([]);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");

  const activeConfig = MODULES[activeModule];
  const activeForm = forms[activeModule];

  const showToast = useCallback((message) => {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const refreshAll = useCallback(async () => {
    const [healthPayload, projectPayload, jobPayload, assetPayload] = await Promise.all([
      api("/api/health"),
      api("/api/projects?archived=1"),
      api("/api/jobs"),
      api("/api/assets")
    ]);
    setHealth(healthPayload);
    setSettings(healthPayload.settings);
    setModels(healthPayload.models || { text: [], image: [], video: [] });
    setProjects(projectPayload.projects || []);
    setJobs(jobPayload.jobs || []);
    setAssets(assetPayload.assets || []);
    setForms((current) => ({
      text: {
        ...current.text,
        model: current.text.model || firstModel(healthPayload.settings, healthPayload.models, "textModel")
      },
      image: {
        ...current.image,
        model: current.image.model || firstModel(healthPayload.settings, healthPayload.models, "imageModel")
      },
      video: {
        ...current.video,
        model: current.video.model || firstModel(healthPayload.settings, healthPayload.models, "videoModel")
      }
    }));
  }, []);

  useEffect(() => {
    refreshAll().catch((error) => showToast(error.message));
  }, [refreshAll, showToast]);

  useEffect(() => {
    if (activeModule !== "video") return undefined;
    const timer = window.setInterval(() => {
      refreshAll().catch(() => {});
    }, 8000);
    return () => window.clearInterval(timer);
  }, [activeModule, refreshAll]);

  const moduleProjects = useMemo(
    () => projects.filter((project) => moduleFromProject(project) === activeModule && project.status !== "archived"),
    [activeModule, projects]
  );

  const moduleProjectIds = useMemo(() => new Set(moduleProjects.map((project) => project.id)), [moduleProjects]);

  const moduleJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          job.type === activeConfig.jobType &&
          (moduleProjectIds.has(job.projectId) || job.projectId === selectedProjectIds[activeModule])
      ),
    [activeConfig.jobType, activeModule, jobs, moduleProjectIds, selectedProjectIds]
  );

  const moduleAssets = useMemo(() => {
    const expectedKind = activeModule === "video" ? "video" : activeModule === "image" ? "image" : "";
    if (!expectedKind) return [];
    return assets.filter((asset) => asset.kind === expectedKind && moduleProjectIds.has(asset.projectId));
  }, [activeModule, assets, moduleProjectIds]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectIds[activeModule]) || null,
    [activeModule, projects, selectedProjectIds]
  );

  const patchForm = (moduleId, patch) => {
    setForms((current) => ({
      ...current,
      [moduleId]: (() => {
        const nextForm = {
          ...current[moduleId],
          ...patch
        };
        if (moduleId === "video") {
          const resolutions = videoResolutionOptions(nextForm);
          if (!resolutions.includes(String(nextForm.resolution || ""))) {
            nextForm.resolution = "720p";
          }
          const durations = videoDurationOptions(nextForm);
          if (!durations.includes(String(nextForm.duration || ""))) {
            nextForm.duration = "8";
          }
        }
        return nextForm;
      })()
    }));
  };

  const projectConfigFromForm = (moduleId, form = forms[moduleId]) => {
    const common = {
      appModule: moduleId,
      modulePrompt: form.prompt || "",
      moduleFileName: form.fileName || form.referenceFileName || ""
    };
    if (moduleId === "text") {
      return {
        ...common,
        textModel: form.model,
        textSystemPrompt: form.system,
        textTemperature: form.temperature,
        textMaxTokens: form.maxTokens,
        moduleOutput: form.output,
        moduleResultJobId: form.resultJobId || ""
      };
    }
    if (moduleId === "image") {
      return {
        ...common,
        imageModel: form.model,
        aspectRatio: form.aspectRatio,
        imageSize: form.imageSize,
        imageNegativePrompt: form.negativePrompt,
        moduleResultAssetId: form.resultAssetId
      };
    }
    return {
      ...common,
      videoModel: form.model,
      aspectRatio: form.aspectRatio,
      resolution: form.resolution,
      duration: form.duration,
      referenceMode: form.referenceMode,
      videoReferenceUrl: form.referenceUrl,
      videoReferenceAssetId: form.referenceAssetId,
      videoReferenceWidth: form.referenceWidth,
      videoReferenceHeight: form.referenceHeight,
      moduleResultJobId: form.resultJobId,
      moduleResultAssetId: form.resultAssetId
    };
  };

  const applyProjectToForm = (project, moduleId = activeModule) => {
    const config = project.config || {};
    const moduleConfig = MODULES[moduleId];
    const patch = {
      projectName: project.name || "",
      description: project.description || "",
      prompt: config.modulePrompt || ""
    };
    if (moduleId === "text") {
      Object.assign(patch, {
        model: config.textModel || settings?.models?.textModel || "",
        system: config.textSystemPrompt || forms.text.system,
        temperature: config.textTemperature || "0.72",
        maxTokens: config.textMaxTokens || "",
        output: config.moduleOutput || "",
        resultJobId: config.moduleResultJobId || "",
        fileName: config.moduleFileName || ""
      });
    } else if (moduleId === "image") {
      Object.assign(patch, {
        model: config.imageModel || settings?.models?.imageModel || "",
        aspectRatio: config.aspectRatio || "16:9",
        imageSize: config.imageSize || "2K",
        negativePrompt: config.imageNegativePrompt || "",
        resultAssetId: config.moduleResultAssetId || "",
        referenceDataUrl: "",
        referenceFileName: config.moduleFileName || ""
      });
    } else {
      const referenceAsset = config.videoReferenceAssetId
        ? assets.find((asset) => asset.id === config.videoReferenceAssetId)
        : projectVideoReferenceAsset(project, assets);
      Object.assign(patch, {
        model: config.videoModel || settings?.models?.videoModel || "",
        aspectRatio: config.aspectRatio || "16:9",
        resolution: config.resolution || "720p",
        duration: config.duration || "8",
        referenceMode: config.referenceMode || "native_multipart",
        referenceUrl: config.videoReferenceUrl || "",
        referenceAssetId: config.videoReferenceAssetId || referenceAsset?.id || "",
        referenceWidth: config.videoReferenceWidth || referenceAsset?.metadata?.width || "",
        referenceHeight: config.videoReferenceHeight || referenceAsset?.metadata?.height || "",
        resultJobId: config.moduleResultJobId || "",
        resultAssetId: config.moduleResultAssetId || "",
        referenceDataUrl: "",
        referenceFileName: config.moduleFileName || referenceAsset?.filename || ""
      });
    }
    setSelectedProjectIds((current) => ({ ...current, [moduleId]: project.id }));
    patchForm(moduleConfig.id, patch);
    setActiveTab("workbench");
  };

  const createProject = async (moduleId = activeModule) => {
    const moduleConfig = MODULES[moduleId];
    const form = forms[moduleId];
    const name = form.projectName.trim() || `${moduleConfig.projectPrefix} ${stamp()}`;
    const payload = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: form.description || "",
        config: projectConfigFromForm(moduleId, { ...form, projectName: name })
      })
    });
    setSelectedProjectIds((current) => ({ ...current, [moduleId]: payload.project.id }));
    patchForm(moduleId, { projectName: payload.project.name, description: payload.project.description });
    await refreshAll();
    showToast("项目已创建");
    return payload.project;
  };

  const ensureProject = async (moduleId = activeModule) => {
    const currentId = selectedProjectIds[moduleId];
    const current = projects.find((project) => project.id === currentId && project.status !== "archived");
    if (current) return current;
    return createProject(moduleId);
  };

  const saveProject = async (moduleId = activeModule, patch = {}) => {
    const project = await ensureProject(moduleId);
    const form = { ...forms[moduleId], ...patch };
    const payload = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: form.projectName?.trim() || project.name,
        description: form.description || "",
        config: projectConfigFromForm(moduleId, form)
      })
    });
    setSelectedProjectIds((current) => ({ ...current, [moduleId]: payload.project.id }));
    await refreshAll();
    showToast("项目已保存");
    return payload.project;
  };

  const archiveProject = async (project) => {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" })
    });
    await refreshAll();
    showToast("项目已归档");
  };

  const ensureConfigured = () => {
    if (health?.configured) return true;
    setActiveTab("settings");
    showToast("请先保存 Gemini 中转站 API Key");
    return false;
  };

  const runTextGeneration = async () => {
    if (!ensureConfigured()) return;
    if (!activeForm.prompt.trim()) {
      showToast("先填写文本提示词");
      return;
    }
    setBusy("text");
    try {
      const project = await saveProject("text");
      const payload = await api("/api/text/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          model: forms.text.model,
          system: forms.text.system,
          prompt: forms.text.prompt,
          temperature: Number(forms.text.temperature || 0.72),
          maxTokens: forms.text.maxTokens ? Number(forms.text.maxTokens) : undefined
        })
      });
      const output = payload.text || "";
      patchForm("text", { output, resultJobId: payload.job?.id || "" });
      await saveProject("text", { output, resultJobId: payload.job?.id || "" });
      showToast("文本生成完成");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy("");
    }
  };

  const runImageGeneration = async () => {
    if (!ensureConfigured()) return;
    if (!activeForm.prompt.trim()) {
      showToast("先填写图片提示词");
      return;
    }
    setBusy("image");
    try {
      const project = await saveProject("image");
      const prompt = [
        forms.image.prompt,
        forms.image.negativePrompt ? `避免：${forms.image.negativePrompt}` : ""
      ]
        .filter(Boolean)
        .join("\n");
      const payload = await api("/api/image/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          model: forms.image.model,
          prompt,
          aspectRatio: forms.image.aspectRatio,
          imageSize: forms.image.imageSize,
          imageDataUrl: forms.image.referenceDataUrl || "",
          libraryType: "general",
          libraryTitle: forms.image.projectName || project.name
        })
      });
      const resultAssetId = payload.assets?.[0]?.id || "";
      patchForm("image", { resultAssetId });
      await saveProject("image", { resultAssetId });
      showToast("图片生成完成");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy("");
    }
  };

  const runVideoGeneration = async () => {
    if (!ensureConfigured()) return;
    if (!activeForm.prompt.trim()) {
      showToast("先填写视频提示词");
      return;
    }
    const blockedReason = videoDurationConstraintReason(forms.video);
    if (blockedReason) {
      showToast(blockedReason);
      return;
    }
    setBusy("video");
    try {
      const project = await saveProject("video");
      const payload = await api("/api/video/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          model: forms.video.model,
          prompt: forms.video.prompt,
          aspectRatio: forms.video.aspectRatio,
          resolution: forms.video.resolution,
          duration: forms.video.duration,
          referenceMode: forms.video.referenceMode,
          imageAssetId: forms.video.referenceDataUrl ? "" : (forms.video.referenceAssetId || ""),
          imageDataUrl: forms.video.referenceDataUrl || "",
          imageUrl: forms.video.referenceUrl || "",
          referenceFileName: forms.video.referenceFileName || ""
        })
      });
      const referenceAssetId = payload.job?.config?.imageAssetId || forms.video.referenceAssetId || "";
      const nextPatch = {
        resultJobId: payload.job?.id || "",
        referenceAssetId,
        referenceWidth: forms.video.referenceWidth || "",
        referenceHeight: forms.video.referenceHeight || ""
      };
      patchForm("video", nextPatch);
      await saveProject("video", nextPatch);
      showToast("视频任务已提交，右侧历史会自动刷新");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy("");
    }
  };

  const handleTextUpload = async (file) => {
    if (!file) return;
    const text = await file.text();
    patchForm("text", {
      prompt: forms.text.prompt ? `${forms.text.prompt}\n\n${text}` : text,
      fileName: file.name
    });
  };

  const handleReferenceUpload = async (moduleId, file) => {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    const imageInfo = await imageInfoFromDataUrl(dataUrl);
    const patch = {
      referenceDataUrl: dataUrl,
      referenceAssetId: "",
      referenceWidth: imageInfo.width || "",
      referenceHeight: imageInfo.height || "",
      referenceFileName: file.name
    };
    if (moduleId === "video") {
      const orientation = referenceOrientationFromDimensions(imageInfo);
      if (orientation === "portrait") patch.aspectRatio = "9:16";
      if (orientation === "landscape") patch.aspectRatio = "16:9";
    }
    patchForm(moduleId, patch);
  };

  const loadJobIntoForm = async (job, moduleId = activeModule) => {
    if (!job?.id) return;
    let fullJob = job;
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(job.id)}?full=1`);
      fullJob = payload.job || job;
    } catch (error) {
      showToast(`历史任务载入失败：${error.message}`);
    }

    const current = forms[moduleId] || {};
    const patch = {
      model: fullJob.model || current.model || "",
      prompt: fullJob.prompt || ""
    };

    if (fullJob.projectId) {
      setSelectedProjectIds((currentIds) => ({ ...currentIds, [moduleId]: fullJob.projectId }));
    }

    if (moduleId === "text") {
      Object.assign(patch, {
        output: fullJob.result?.text || fullJob.result?.textPreview || "",
        resultJobId: fullJob.id,
        temperature: fullJob.config?.temperature !== undefined ? String(fullJob.config.temperature) : current.temperature,
        maxTokens: fullJob.config?.maxTokens !== undefined ? String(fullJob.config.maxTokens) : current.maxTokens
      });
    } else if (moduleId === "image") {
      const parts = splitImagePromptParts(fullJob.prompt);
      Object.assign(patch, {
        prompt: parts.prompt || fullJob.prompt || "",
        negativePrompt: parts.negativePrompt,
        aspectRatio: fullJob.config?.aspectRatio || current.aspectRatio || "16:9",
        imageSize: fullJob.config?.imageSize || current.imageSize || "2K",
        resultAssetId: assetIdFromJob(fullJob, assets, "image")
      });
    } else if (moduleId === "video") {
      const referenceAssetId =
        fullJob.config?.imageAssetId ||
        (Array.isArray(fullJob.config?.referenceAssetIds) ? fullJob.config.referenceAssetIds[0] : "") ||
        "";
      const referenceAsset = referenceAssetId ? assets.find((asset) => asset.id === referenceAssetId) : null;
      Object.assign(patch, {
        aspectRatio: fullJob.config?.aspectRatio || current.aspectRatio || "16:9",
        resolution: fullJob.config?.resolution || current.resolution || "720p",
        duration: String(fullJob.config?.duration || current.duration || "8"),
        referenceMode: fullJob.config?.referenceMode || current.referenceMode || "native_multipart",
        referenceUrl: fullJob.config?.imageUrl || current.referenceUrl || "",
        referenceAssetId,
        referenceDataUrl: "",
        referenceWidth: referenceAsset?.metadata?.width || current.referenceWidth || "",
        referenceHeight: referenceAsset?.metadata?.height || current.referenceHeight || "",
        referenceFileName: referenceAsset?.filename || current.referenceFileName || "",
        resultJobId: fullJob.id,
        resultAssetId: assetIdFromJob(fullJob, assets, "video")
      });
    }

    patchForm(moduleId, patch);
    setActiveTab("workbench");
  };

  const switchMainModule = (moduleId) => {
    setActiveModule(moduleId);
    if (activeTab === "settings") setActiveTab("workbench");
  };

  return (
    <div className="app-shell text-clay-900">
      <div className="grid h-screen w-full grid-cols-[84px_minmax(0,1fr)] gap-4 px-5 py-3">
        <aside className="soft-rail">
          <div className="rail-brand">
            <Sparkles size={24} />
          </div>
          <div className="rail-stack">
            {MODULE_ORDER.map((moduleId) => {
              const item = MODULES[moduleId];
              const Icon = item.icon;
              return (
                <button
                  key={moduleId}
                  className={cx("rail-button", activeModule === moduleId && activeTab !== "settings" && "active")}
                  type="button"
                  title={item.title}
                  onClick={() => switchMainModule(moduleId)}
                >
                  <Icon size={22} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <button
            className={cx("rail-button mt-auto", activeTab === "settings" && "active")}
            type="button"
            title="API 设置"
            onClick={() => setActiveTab("settings")}
          >
            <Settings size={22} />
            <span>API</span>
          </button>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col">
          <Header
            activeConfig={activeConfig}
            activeModule={activeModule}
            form={activeForm}
            health={health}
            models={models}
            activeTab={activeTab}
            showViewToggle={activeTab !== "settings"}
            showModelPicker={activeTab === "workbench"}
            onPatch={(patch) => patchForm(activeModule, patch)}
            onToggleView={() => setActiveTab(activeTab === "projects" ? "workbench" : "projects")}
            onRefresh={() => refreshAll().then(() => showToast("已刷新")).catch((error) => showToast(error.message))}
          />

          {activeTab === "settings" ? (
            <SettingsPanel
              settings={settings}
              models={models}
              onSaved={async () => {
                await refreshAll();
                showToast("API 设置已保存");
              }}
            />
          ) : (
            <>
              {activeTab === "workbench" ? (
                <ModuleWorkbench
                  activeModule={activeModule}
                  activeConfig={activeConfig}
                  form={activeForm}
                  projects={moduleProjects}
                  jobs={moduleJobs}
                  assets={moduleAssets}
                  allAssets={assets}
                  selectedProject={selectedProject}
                  models={models}
                  busy={busy}
                  onPatch={(patch) => patchForm(activeModule, patch)}
                  onSelectProject={(project) => applyProjectToForm(project, activeModule)}
                  onCreateProject={() => createProject(activeModule)}
                  onSaveProject={() => saveProject(activeModule)}
                  onTextUpload={handleTextUpload}
                  onReferenceUpload={handleReferenceUpload}
                  onRunText={runTextGeneration}
                  onRunImage={runImageGeneration}
                  onRunVideo={runVideoGeneration}
                  onLoadJob={(job) => loadJobIntoForm(job, activeModule)}
                />
              ) : (
                <ProjectHistory
                  activeConfig={activeConfig}
                  projects={moduleProjects}
                  jobs={moduleJobs}
                  assets={moduleAssets}
                  onLoadProject={(project) => applyProjectToForm(project, activeModule)}
                  onArchiveProject={archiveProject}
                  onLoadJob={(job) => loadJobIntoForm(job, activeModule)}
                />
              )}
            </>
          )}
        </main>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      <ModelDatalists models={models} />
    </div>
  );
}

function Header({ activeConfig, activeModule, form, health, models, activeTab, showViewToggle, showModelPicker, onPatch, onToggleView, onRefresh }) {
  const Icon = activeConfig.icon;
  const ToggleIcon = activeTab === "projects" ? WandSparkles : History;
  const toggleLabel = activeTab === "projects" ? "生成区" : "历史项目";
  return (
    <header className="app-header">
      <div>
        <div className="flex items-center gap-3 text-clay-600">
          <div className="soft-mini-icon">
            <Icon size={18} />
          </div>
          <span className="text-sm font-semibold">Gemini Relay Studio</span>
        </div>
        <h1 className="mt-2 text-[30px] font-black leading-none text-clay-800">{activeConfig.title}</h1>
        <p className="mt-2 max-w-2xl text-sm font-medium text-clay-600">{activeConfig.subtitle}</p>
      </div>
      <div className="header-actions">
        {showModelPicker ? <HeaderModelInput activeModule={activeModule} form={form} models={models} onPatch={onPatch} /> : null}
        {showViewToggle ? (
          <button className="view-toggle-button" type="button" onClick={onToggleView}>
            <ToggleIcon size={17} />
            {toggleLabel}
          </button>
        ) : null}
        <div className="profile-pill">
          <div className="avatar-placeholder">
            <Bot size={25} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-clay-800">Gemini 中转站</p>
            <p className="truncate text-xs font-semibold text-clay-600">
              {health?.configured ? `已连接 ${health.baseUrl}` : "等待配置 API Key"}
            </p>
          </div>
          <button className="soft-icon-button ml-auto" type="button" title="刷新" onClick={onRefresh}>
            <RefreshCw size={17} />
          </button>
          <MoreVertical className="text-clay-600" size={19} />
        </div>
      </div>
    </header>
  );
}

function HeaderModelInput({ activeModule, form, models, onPatch }) {
  const listId = `${activeModule}-models`;
  const values = activeModule === "text" ? models.text : activeModule === "image" ? models.image : models.video;
  return (
    <label className="header-model-picker">
      <span>模型</span>
      <input
        className="soft-input"
        list={listId}
        value={form.model}
        onChange={(event) => onPatch({ model: event.target.value })}
        placeholder={values?.[0] || "输入模型名称"}
      />
    </label>
  );
}

function ModuleWorkbench({
  activeModule,
  activeConfig,
  form,
  projects,
  jobs,
  assets,
  allAssets,
  selectedProject,
  models,
  busy,
  onPatch,
  onSelectProject,
  onCreateProject,
  onSaveProject,
  onTextUpload,
  onReferenceUpload,
  onRunText,
  onRunImage,
  onRunVideo,
  onLoadJob
}) {
  const runHandler = activeModule === "text" ? onRunText : activeModule === "image" ? onRunImage : onRunVideo;
  const scopedJobs = selectedProject ? jobs.filter((job) => job.projectId === selectedProject.id) : jobs;
  const scopedAssets = selectedProject ? assets.filter((asset) => asset.projectId === selectedProject.id) : assets;

  return (
    <div className="dashboard-grid">
      <section className="dashboard-column min-w-0">
        <GeneratorControl
          activeModule={activeModule}
          activeConfig={activeConfig}
          form={form}
          busy={busy}
          onPatch={onPatch}
          onRun={runHandler}
          onTextUpload={onTextUpload}
          onReferenceUpload={onReferenceUpload}
        />
      </section>

      <ResultPanel
        activeConfig={activeConfig}
        activeModule={activeModule}
        form={form}
        jobs={scopedJobs}
        assets={scopedAssets}
        selectedProject={selectedProject}
      />

      <section className="dashboard-column min-w-0">
        <ProjectTaskPanel
          activeConfig={activeConfig}
          form={form}
          projects={projects}
          jobs={scopedJobs}
          selectedProject={selectedProject}
          onPatch={onPatch}
          onSelectProject={onSelectProject}
          onCreateProject={onCreateProject}
          onSaveProject={onSaveProject}
          onLoadJob={onLoadJob}
        />
      </section>
    </div>
  );
}

function GeneratorControl({
  activeModule,
  activeConfig,
  form,
  busy,
  onPatch,
  onRun,
  onTextUpload,
  onReferenceUpload
}) {
  const Icon = activeConfig.icon;
  const running = busy === activeModule;
  const blockedReason = activeModule === "video" ? videoDurationConstraintReason(form) : "";
  const disabled = running || Boolean(blockedReason);
  return (
    <section className="soft-card generator-card p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={cx("module-icon", `accent-${activeConfig.accent}`)}>
            <Icon size={25} />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-clay-800">{activeConfig.title}</h2>
            <p className="text-xs font-semibold text-clay-600">Gemini relay API</p>
          </div>
        </div>
        <div className="generator-status">
          <ModuleDial activeModule={activeModule} form={form} />
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        {activeModule === "text" ? (
          <TextControls form={form} onPatch={onPatch} onTextUpload={onTextUpload} />
        ) : activeModule === "image" ? (
          <ImageControls form={form} onPatch={onPatch} onReferenceUpload={(file) => onReferenceUpload("image", file)} />
        ) : (
          <VideoControls form={form} onPatch={onPatch} onReferenceUpload={(file) => onReferenceUpload("video", file)} />
        )}
        {blockedReason ? <p className="text-xs font-extrabold text-ember">{blockedReason}</p> : null}
        <button className="primary-action generate-action" type="button" onClick={onRun} disabled={disabled} title={blockedReason || undefined}>
          {running ? <Loader2 className="animate-spin" size={18} /> : <Zap size={18} />}
          {running ? "生成中" : "开始生成"}
        </button>
      </div>
    </section>
  );
}

function ModuleDial({ activeModule, form }) {
  const value =
    activeModule === "text"
      ? form.temperature || "0.72"
      : activeModule === "image"
        ? form.imageSize || "2K"
        : `${form.duration || "8"}s`;
  const label =
    activeModule === "text"
      ? "Temperature"
      : activeModule === "image"
        ? form.aspectRatio || "16:9"
        : form.resolution || "720p";
  const progress =
    activeModule === "text"
      ? Math.min(260, Math.max(28, Number(form.temperature || 0.72) * 150))
      : activeModule === "image"
        ? form.imageSize === "4K"
          ? 244
          : form.imageSize === "2K"
            ? 182
            : 116
        : Math.min(250, Number(form.duration || 8) * 28);

  return (
    <div className="dial-shell">
      <div className="dial-arc" style={{ "--dial-progress": `${progress}deg` }}>
        <div className="dial-inner">
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      </div>
      <div className="dial-scale">
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
    </div>
  );
}

function TextControls({ form, onPatch, onTextUpload }) {
  return (
    <>
      <label className="field-label">
        生成提示词
        <textarea
          className="soft-textarea prompt-area"
          value={form.prompt}
          onChange={(event) => onPatch({ prompt: event.target.value })}
          placeholder="输入你要生成的文本需求。"
        />
      </label>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <label className="field-label">
          温度
          <input
            className="range-neu"
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={form.temperature}
            onChange={(event) => onPatch({ temperature: event.target.value })}
          />
        </label>
        <label className="upload-button compact-upload">
          <Upload size={17} />
          上传
          <input className="hidden" type="file" accept=".txt,.md,.json,.csv" onChange={(event) => onTextUpload(event.target.files?.[0])} />
        </label>
      </div>
      {form.fileName ? <p className="text-xs font-semibold text-clay-600">已载入：{form.fileName}</p> : null}
      <details className="advanced-panel">
        <summary>高级文本设置</summary>
        <div className="mt-3 grid gap-3">
          <label className="field-label">
            系统提示词
            <textarea className="soft-textarea min-h-[58px]" value={form.system} onChange={(event) => onPatch({ system: event.target.value })} />
          </label>
          <label className="field-label">
            Max tokens
            <input
              className="soft-input"
              type="number"
              min="1"
              value={form.maxTokens}
              onChange={(event) => onPatch({ maxTokens: event.target.value })}
              placeholder="自动"
            />
          </label>
        </div>
      </details>
    </>
  );
}

function ImageControls({ form, onPatch, onReferenceUpload }) {
  return (
    <>
      <label className="field-label">
        图片提示词
        <textarea
          className="soft-textarea prompt-area"
          value={form.prompt}
          onChange={(event) => onPatch({ prompt: event.target.value })}
          placeholder="描述画面主体、风格、构图、光线。"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Segmented label="比例" value={form.aspectRatio} options={["16:9", "9:16", "1:1"]} onChange={(value) => onPatch({ aspectRatio: value })} />
        <Segmented label="尺寸" value={form.imageSize} options={["1K", "2K", "4K"]} onChange={(value) => onPatch({ imageSize: value })} />
      </div>
      <ReferencePicker fileName={form.referenceFileName} onPick={onReferenceUpload} accept="image/png,image/jpeg,image/webp" />
      <details className="advanced-panel">
        <summary>高级图片设置</summary>
        <label className="field-label mt-3">
          避免内容
          <input
            className="soft-input"
            value={form.negativePrompt}
            onChange={(event) => onPatch({ negativePrompt: event.target.value })}
            placeholder="可选，例如：低清晰度、文字、水印"
          />
        </label>
      </details>
    </>
  );
}

function VideoControls({ form, onPatch, onReferenceUpload }) {
  const resolutionOptions = videoResolutionOptions(form);
  const resolutionHint = videoResolutionLockHint(form);
  const durationOptions = videoDurationOptions(form);
  const durationHint = videoDurationLockHint(form);
  const helperHint = resolutionHint || durationHint;
  return (
    <>
      <label className="field-label">
        视频提示词
        <textarea
          className="soft-textarea video-prompt-area"
          value={form.prompt}
          onChange={(event) => onPatch({ prompt: event.target.value })}
          placeholder="描述视频动作、镜头、场景变化和风格。"
        />
      </label>
      <div className="grid grid-cols-3 gap-3">
        <Segmented label="比例" value={form.aspectRatio} options={["16:9", "9:16"]} onChange={(value) => onPatch({ aspectRatio: value })} />
        <label className="field-label">
          清晰度
          <select className="soft-input" value={form.resolution} onChange={(event) => onPatch({ resolution: event.target.value })}>
            {resolutionOptions.map((value) => (
              <option key={value} value={value}>
                {value === "4k" ? "4K" : value}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          时长
          <select className="soft-input" value={form.duration} onChange={(event) => onPatch({ duration: event.target.value })}>
            {durationOptions.map((value) => (
              <option key={value} value={value}>
                {value} 秒
              </option>
            ))}
          </select>
        </label>
      </div>
      {helperHint ? <p className="control-hint">{helperHint}</p> : null}
      <ReferencePicker fileName={form.referenceFileName} onPick={onReferenceUpload} accept="image/png,image/jpeg,image/webp" />
      <details className="advanced-panel">
        <summary>高级视频设置</summary>
        <div className="mt-3 grid gap-3">
          <label className="field-label">
            参考图模式
            <select className="soft-input" value={form.referenceMode} onChange={(event) => onPatch({ referenceMode: event.target.value })}>
              <option value="native_multipart">原生图生视频 multipart</option>
              <option value="native_json">原生图生视频 JSON</option>
              <option value="vision_prompt">兼容模式：图片理解后文生视频</option>
            </select>
          </label>
          <label className="field-label">
            参考图 URL
            <input
              className="soft-input"
              type="url"
              value={form.referenceUrl}
              onChange={(event) => onPatch({ referenceUrl: event.target.value })}
              placeholder="可选，https://..."
            />
          </label>
        </div>
      </details>
    </>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="field-label">
      {label}
      <div className="segmented" style={{ "--segment-count": options.length }}>
        {options.map((option) => (
          <button key={option} className={cx(value === option && "active")} type="button" onClick={() => onChange(option)}>
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReferencePicker({ fileName, onPick, accept }) {
  return (
    <label className="upload-button">
      <Upload size={17} />
      {fileName ? `参考图：${fileName}` : "上传参考图"}
      <input className="hidden" type="file" accept={accept} onChange={(event) => onPick(event.target.files?.[0])} />
    </label>
  );
}

function TaskHistoryList({ activeConfig, jobs, onLoadJob, limit = 8 }) {
  const Icon = activeConfig.icon;
  const visibleJobs = jobs.slice(0, limit);
  return (
    <div className="history-list compact-history-list">
      {visibleJobs.length ? (
        visibleJobs.map((job) => (
          <button key={job.id} className="history-row" type="button" onClick={() => onLoadJob(job)}>
            <span className="history-icon">
              <Icon size={18} />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <strong>{preview(job.prompt, 38)}</strong>
              <em>
                {job.status} · {job.model}
              </em>
            </span>
            <ChevronRight size={21} />
          </button>
        ))
      ) : (
        <EmptyState icon={History} text="暂无任务历史" />
      )}
    </div>
  );
}

function ProjectTaskPanel({
  activeConfig,
  form,
  projects,
  jobs,
  selectedProject,
  onPatch,
  onSelectProject,
  onCreateProject,
  onSaveProject,
  onLoadJob
}) {
  const visibleProjects = projects.slice(0, 8);
  return (
    <section className="soft-card project-card project-task-panel p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-extrabold text-clay-800">项目与历史</h2>
          <p className="text-xs font-semibold text-clay-600">{selectedProject ? `已选择 ${selectedProject.name}` : "未选择项目"}</p>
        </div>
        <div className="flex gap-2">
          <button className="soft-icon-button" type="button" title="新建项目" onClick={onCreateProject}>
            <CirclePlus size={18} />
          </button>
          <button className="soft-icon-button" type="button" title="保存项目" onClick={onSaveProject}>
            <Save size={18} />
          </button>
        </div>
      </div>
      <div className="project-card-body project-task-body">
        <label className="field-label">
          项目名称
          <input
            className="soft-input"
            value={form.projectName}
            onChange={(event) => onPatch({ projectName: event.target.value })}
            placeholder={`${activeConfig.projectPrefix} ${stamp()}`}
          />
        </label>
        <div className="side-section">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-extrabold text-clay-600">任务历史</span>
            <span className="text-[11px] font-bold text-clay-600">{jobs.length} 条</span>
          </div>
          <TaskHistoryList activeConfig={activeConfig} jobs={jobs} onLoadJob={onLoadJob} limit={8} />
        </div>
        <div className="project-picks">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-extrabold text-clay-600">项目列表</span>
            <span className="text-[11px] font-bold text-clay-600">{projects.length} 个</span>
          </div>
          <div className="grid gap-2">
            {visibleProjects.length ? (
              visibleProjects.map((project) => (
                <button
                  key={project.id}
                  className={cx("project-pick", selectedProject?.id === project.id && "active")}
                  type="button"
                  onClick={() => onSelectProject(project)}
                >
                  <span className="min-w-0 truncate">{project.name}</span>
                  <em>{formatDate(project.updatedAt)}</em>
                </button>
              ))
            ) : (
              <button className="project-pick" type="button" onClick={onCreateProject}>
                <span>新建第一个项目</span>
                <em>空白</em>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ResultPreview({ activeModule, form, jobs, assets }) {
  const expectedKind = activeModule === "image" ? "image" : activeModule === "video" ? "video" : "";
  const { resultJob, resultAsset } = resultSelection(form, jobs, assets, expectedKind);
  return (
    <>
      {activeModule === "text" ? (
        <pre className="result-text">{form.output || "暂无文本结果"}</pre>
      ) : activeModule === "image" ? (
        resultAsset ? (
          <div className="media-preview">{resultAsset.mime?.startsWith("image/") ? <img src={resultAsset.url} alt={assetTitle(resultAsset)} /> : null}</div>
        ) : (
          <EmptyState icon={ImageIcon} text="暂无图片结果" />
        )
      ) : resultAsset ? (
        <div className="media-preview">{resultAsset.mime?.startsWith("video/") ? <video src={resultAsset.url} controls /> : null}</div>
      ) : (
        <EmptyState icon={Film} text={resultJob ? `任务状态：${resultJob.status}` : "暂无视频结果"} />
      )}
      <div className="mt-3 flex justify-end">
        {activeModule === "text" && form.output ? (
          <button className="asset-chip" type="button" title="下载文本" onClick={() => downloadBlob(form.output, "text-result.txt")}>
            <Download size={14} />
            下载文本
          </button>
        ) : resultAsset?.url ? (
          <button className="asset-chip" type="button" title="下载素材" onClick={() => downloadUrl(resultAsset.url, resultAsset.filename)}>
            <Download size={14} />
            下载结果
          </button>
        ) : null}
      </div>
    </>
  );
}

function materialPreviewRows(activeModule, form, resultJob, resultAsset) {
  const config = resultJob?.config || {};
  const rows = [
    ["类型", assetKindLabel(resultAsset?.kind || activeModule)],
    ["模型", compactValue(resultJob?.model || form.model)],
    ["状态", compactValue(resultJob?.status, "待生成")]
  ];

  if (activeModule === "text") {
    rows.push(["温度", compactValue(config.temperature ?? form.temperature)]);
    rows.push(["Max tokens", compactValue(config.maxTokens ?? form.maxTokens, "自动")]);
  } else if (activeModule === "image") {
    rows.push(["比例", compactValue(config.aspectRatio || form.aspectRatio)]);
    rows.push(["尺寸", compactValue(config.imageSize || form.imageSize)]);
    rows.push(["像素", compactValue(assetDimensions(resultAsset), "生成后显示")]);
  } else {
    const referenceLabel = config.referenceImageCount
      ? `${config.referenceImageCount} 张`
      : form.referenceFileName || form.referenceAssetId
        ? "已上传"
        : "无";
    rows.push(["比例", compactValue(config.aspectRatio || form.aspectRatio)]);
    rows.push(["清晰度", compactValue(config.resolution || form.resolution)]);
    rows.push(["时长", `${compactValue(config.duration || form.duration, "8")} 秒`]);
    rows.push(["参考图", referenceLabel]);
  }

  rows.push(["文件", compactValue(resultAsset?.filename, "未保存")]);
  rows.push(["时间", compactValue(formatDate(resultJob?.updatedAt || resultAsset?.updatedAt || resultAsset?.createdAt), "暂无")]);
  return rows.slice(0, activeModule === "video" ? 9 : 8);
}

function MaterialInspector({ activeModule, form, jobs, assets }) {
  const expectedKind = activeModule === "image" ? "image" : activeModule === "video" ? "video" : "";
  const { resultJob, resultAsset } = resultSelection(form, jobs, assets, expectedKind);
  const rows = materialPreviewRows(activeModule, form, resultJob, resultAsset);
  return (
    <div className="asset-inspector">
      <div className="asset-inspector-head">
        <div className="min-w-0">
          <h3>素材参数预览</h3>
          <p>{resultAsset ? assetTitle(resultAsset) : resultJob ? `任务 ${resultJob.id}` : "选择历史任务后查看参数"}</p>
        </div>
        <span>{assets.length} 个素材</span>
      </div>
      <div className="asset-param-list">
        {rows.map(([label, value]) => (
          <div key={label} className="asset-param-row">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultPanel({ activeConfig, activeModule, form, jobs, assets, selectedProject = null }) {
  return (
    <aside className="soft-card result-panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-extrabold text-clay-800">生成结果</h2>
          <p className="text-xs font-semibold text-clay-600">{selectedProject ? selectedProject.name : "素材预览、下载、参数检查"}</p>
        </div>
        <div className={cx("soft-mini-icon", `accent-${activeConfig.accent}`)}>
          <SlidersHorizontal size={17} />
        </div>
      </div>
      <div className="result-preview-block">
        <ResultPreview activeModule={activeModule} form={form} jobs={jobs} assets={assets} />
      </div>
      <MaterialInspector activeModule={activeModule} form={form} jobs={jobs} assets={assets} />
    </aside>
  );
}

function ResultHistoryPanel({ activeConfig, activeModule, form, jobs, assets, onLoadJob, showPreview = true, selectedProject = null }) {
  const Icon = activeConfig.icon;
  const visibleJobs = showPreview ? jobs.slice(0, 5) : jobs;
  return (
    <aside className="soft-card result-history-panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-extrabold text-clay-800">结果与历史</h2>
          <p className="text-xs font-semibold text-clay-600">{selectedProject ? selectedProject.name : "预览、下载、二次编辑"}</p>
        </div>
        <div className="soft-mini-icon">
          <SlidersHorizontal size={17} />
        </div>
      </div>
      {showPreview ? (
        <div className="result-preview-block">
          <ResultPreview activeModule={activeModule} form={form} jobs={jobs} assets={assets} />
        </div>
      ) : null}
      <div className="mt-5 mb-3 flex items-center justify-between">
        <span className="text-xs font-extrabold text-clay-600">任务历史</span>
        <span className="text-[11px] font-bold text-clay-600">{jobs.length} 条</span>
      </div>
      <div className="history-list">
        {visibleJobs.length ? (
          visibleJobs.map((job) => (
            <button key={job.id} className="history-row" type="button" onClick={() => onLoadJob(job)}>
              <span className="history-icon">
                <Icon size={18} />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <strong>{preview(job.prompt, 38)}</strong>
                <em>
                  {job.status} · {job.model}
                </em>
              </span>
              <ChevronRight size={22} />
            </button>
          ))
        ) : (
          <EmptyState icon={History} text="暂无任务历史" />
        )}
      </div>
      {showPreview ? <MaterialInspector activeModule={activeModule} form={form} jobs={jobs} assets={assets} /> : null}
    </aside>
  );
}

function ProjectHistory({ activeConfig, projects, jobs, assets, onLoadProject, onArchiveProject, onLoadJob }) {
  const Icon = activeConfig.icon;
  return (
    <div className="project-history-layout">
      <section className="soft-card p-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-extrabold text-clay-800">项目历史</h2>
            <p className="text-xs font-semibold text-clay-600">每个项目都可以重新载入并二次编辑</p>
          </div>
          <History size={20} className="text-clay-600" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          {projects.length ? (
            projects.map((project) => (
              <article key={project.id} className="project-history-card">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className={cx("module-icon", `accent-${activeConfig.accent}`)}>
                    <Icon size={21} />
                  </div>
                  <span className="text-xs font-bold text-clay-600">{formatDate(project.updatedAt)}</span>
                </div>
                <h3>{project.name}</h3>
                <p>{preview(project.config?.modulePrompt || project.description, 110)}</p>
                <div className="mt-5 flex gap-2">
                  <button className="soft-button flex-1" type="button" onClick={() => onLoadProject(project)}>
                    二次编辑
                  </button>
                  <button className="soft-icon-button" type="button" title="归档" onClick={() => onArchiveProject(project)}>
                    <Archive size={17} />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <EmptyState icon={History} text="暂无项目" />
          )}
        </div>
      </section>

      <ResultHistoryPanel
        activeConfig={activeConfig}
        activeModule={activeConfig.id}
        form={{}}
        jobs={jobs}
        assets={assets}
        onLoadJob={onLoadJob}
        showPreview={false}
      />
    </div>
  );
}

function SettingsPanel({ settings, models, onSaved }) {
  const [form, setForm] = useState({
    baseUrl: "",
    apiKey: "",
    routes: DEFAULT_ROUTES,
    models: {
      textModel: "",
      fastTextModel: "",
      visionModel: "",
      imageModel: "",
      videoModel: "",
      videoFallbackModel: ""
    }
  });
  const [saving, setSaving] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!settings) return;
    setForm((current) => ({
      ...current,
      baseUrl: settings.connection?.baseUrl || "https://oneapi.keath.ai",
      routes: {
        ...DEFAULT_ROUTES,
        ...(settings.routes || {})
      },
      models: {
        ...current.models,
        ...(settings.models || {})
      }
    }));
  }, [settings]);

  const patch = (patchValue) => setForm((current) => ({ ...current, ...patchValue }));
  const patchRoutes = (patchValue) => setForm((current) => ({ ...current, routes: { ...current.routes, ...patchValue } }));
  const patchModels = (patchValue) => setForm((current) => ({ ...current, models: { ...current.models, ...patchValue } }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          routes: form.routes,
          models: form.models
        })
      });
      patch({ apiKey: "" });
      await onSaved();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setSaving(false);
    }
  };

  const exportDiagnosticReport = async () => {
    setReporting(true);
    setError("");
    try {
      const report = await api("/api/debug/report");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadBlob(
        JSON.stringify(report, null, 2),
        `gemini-relay-diagnostic-${timestamp}.json`,
        "application/json;charset=utf-8"
      );
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setReporting(false);
    }
  };

  return (
    <section className="settings-layout">
      <div className="soft-card p-5">
        <div className="mb-6 flex items-center gap-3">
          <div className="module-icon accent-moss">
            <PlugZap size={24} />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-clay-800">API 设置</h2>
            <p className="text-xs font-semibold text-clay-600">
              {settings?.connection?.hasApiKey ? `已保存 Key：${settings.connection.keyPreview}` : "未保存 API Key"}
            </p>
          </div>
        </div>
        <div className="grid gap-4">
          <label className="field-label">
            中转站地址
            <input className="soft-input" value={form.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
          </label>
          <label className="field-label">
            API Key
            <input
              className="soft-input"
              type="password"
              value={form.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
              placeholder="粘贴 sk-...，留空则保留已保存 Key"
              autoComplete="off"
            />
          </label>
          <button className="primary-action" type="button" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
            保存 API 设置
          </button>
          {error ? <p className="text-sm font-bold text-red-700">{error}</p> : null}
        </div>
      </div>

      <div className="soft-card p-5">
        <h2 className="mb-5 text-lg font-extrabold text-clay-800">默认模型</h2>
        <div className="grid grid-cols-2 gap-4">
          <SettingsInput label="文本模型" value={form.models.textModel} list="text-models" onChange={(value) => patchModels({ textModel: value })} />
          <SettingsInput label="快速文本" value={form.models.fastTextModel} list="text-models" onChange={(value) => patchModels({ fastTextModel: value })} />
          <SettingsInput label="视觉理解" value={form.models.visionModel} list="text-models" onChange={(value) => patchModels({ visionModel: value })} />
          <SettingsInput label="图片模型" value={form.models.imageModel} list="image-models" onChange={(value) => patchModels({ imageModel: value })} />
          <SettingsInput label="视频模型" value={form.models.videoModel} list="video-models" onChange={(value) => patchModels({ videoModel: value })} />
          <SettingsInput label="视频兜底" value={form.models.videoFallbackModel} list="video-models" onChange={(value) => patchModels({ videoFallbackModel: value })} />
        </div>
      </div>

      <div className="soft-card p-5">
        <h2 className="mb-3 text-lg font-extrabold text-clay-800">诊断日志</h2>
        <p className="mb-5 text-xs font-semibold text-clay-600">
          导出最近任务、视频路由和本地日志，API Key 与素材数据会脱敏。
        </p>
        <button className="soft-button w-full" type="button" onClick={exportDiagnosticReport} disabled={reporting}>
          {reporting ? <Loader2 className="animate-spin" size={17} /> : <Download size={17} />}
          导出诊断包
        </button>
      </div>

      <details className="soft-card settings-routes p-5 lg:col-span-2">
        <summary>
          <span>
            <strong>路由</strong>
            <em>默认可不改，展开后编辑中转站路径</em>
          </span>
        </summary>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <SettingsInput label="文本接口" value={form.routes.chatPath} onChange={(value) => patchRoutes({ chatPath: value })} />
          <SettingsInput label="图片接口" value={form.routes.imageChatPath} onChange={(value) => patchRoutes({ imageChatPath: value })} />
          <SettingsInput label="视频 JSON 接口" value={form.routes.videoCreatePath} onChange={(value) => patchRoutes({ videoCreatePath: value })} />
          <SettingsInput label="视频参考图接口" value={form.routes.videoOpenaiCreatePath} onChange={(value) => patchRoutes({ videoOpenaiCreatePath: value })} />
          <label className="field-label lg:col-span-2">
            视频轮询接口
            <input className="soft-input" value={form.routes.videoPollPaths} onChange={(event) => patchRoutes({ videoPollPaths: event.target.value })} />
          </label>
        </div>
      </details>
    </section>
  );
}

function SettingsInput({ label, value, onChange, list }) {
  return (
    <label className="field-label">
      {label}
      <input className="soft-input" list={list} value={value || ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function EmptyState({ icon: Icon, text }) {
  return (
    <div className="empty-state">
      <Icon size={22} />
      <span>{text}</span>
    </div>
  );
}

function ModelDatalists({ models }) {
  return (
    <>
      <datalist id="text-models">
        {(models.text || []).map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <datalist id="image-models">
        {(models.image || []).map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <datalist id="video-models">
        {(models.video || []).map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </>
  );
}
