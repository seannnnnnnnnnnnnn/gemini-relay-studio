const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "veo3.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      style TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      config_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      result_json TEXT DEFAULT '{}',
      error TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      asset_id TEXT DEFAULT '',
      remote_id TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mime TEXT NOT NULL,
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      source TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      model TEXT DEFAULT '',
      job_id TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT '',
      shot_index INTEGER DEFAULT 0,
      shot_id TEXT DEFAULT '',
      title TEXT DEFAULT '',
      visual_prompt TEXT DEFAULT '',
      video_prompt TEXT DEFAULT '',
      camera TEXT DEFAULT '',
      action TEXT DEFAULT '',
      audio TEXT DEFAULT '',
      negative_prompt TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      image_asset_id TEXT DEFAULT '',
      video_job_id TEXT DEFAULT '',
      video_asset_id TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "projects", "status", "TEXT DEFAULT 'active'");
  ensureColumn(db, "projects", "config_json", "TEXT DEFAULT '{}'");
  ensureColumn(db, "assets", "updated_at", "TEXT DEFAULT ''");
  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function now() {
  return new Date().toISOString();
}

function toJson(value) {
  return JSON.stringify(value || {});
}

function fromJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return fallback;
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    model: row.model,
    prompt: row.prompt,
    config: fromJson(row.config_json),
    result: fromJson(row.result_json),
    error: row.error,
    projectId: row.project_id,
    assetId: row.asset_id,
    remoteId: row.remote_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    path: row.path,
    filename: row.filename,
    source: row.source,
    prompt: row.prompt,
    model: row.model,
    jobId: row.job_id,
    projectId: row.project_id,
    metadata: fromJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    url: `/media/${row.id}`
  };
}

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    style: row.style,
    status: row.status || "active",
    config: fromJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToShot(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    shotIndex: row.shot_index,
    shotId: row.shot_id,
    title: row.title,
    visualPrompt: row.visual_prompt,
    videoPrompt: row.video_prompt,
    camera: row.camera,
    action: row.action,
    audio: row.audio,
    negativePrompt: row.negative_prompt,
    status: row.status,
    imageAssetId: row.image_asset_id,
    videoJobId: row.video_job_id,
    videoAssetId: row.video_asset_id,
    metadata: fromJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createStore(db) {
  return {
    touchProject(id) {
      if (!id) return;
      db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), id);
    },

    createProject(project) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO projects (id, name, description, style, status, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        project.name,
        project.description || "",
        project.style || "",
        project.status || "active",
        toJson(project.config),
        timestamp,
        timestamp
      );
      return this.getProject(project.id);
    },

    updateProject(id, patch) {
      const current = this.getProject(id);
      if (!current) return null;
      const next = {
        ...current,
        ...patch,
        config: patch.config === undefined ? current.config : patch.config
      };
      db.prepare(`
        UPDATE projects
        SET name = ?, description = ?, style = ?, status = ?, config_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name || "未命名项目",
        next.description || "",
        next.style || "",
        next.status || "active",
        toJson(next.config),
        now(),
        id
      );
      return this.getProject(id);
    },

    listProjects(options = {}) {
      if (options.includeArchived) {
        return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all().map(rowToProject);
      }
      return db.prepare("SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC").all().map(rowToProject);
    },

    getProject(id) {
      return rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
    },

    createJob(job) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO jobs (
          id, type, status, model, prompt, config_json, result_json, error,
          project_id, asset_id, remote_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.type,
        job.status || "queued",
        job.model,
        job.prompt,
        toJson(job.config),
        toJson(job.result),
        job.error || "",
        job.projectId || "",
        job.assetId || "",
        job.remoteId || "",
        timestamp,
        timestamp
      );
      this.touchProject(job.projectId || "");
      return this.getJob(job.id);
    },

    updateJob(id, patch) {
      const current = this.getJob(id);
      if (!current) return null;

      const next = {
        ...current,
        ...patch,
        config: patch.config === undefined ? current.config : patch.config,
        result: patch.result === undefined ? current.result : patch.result
      };

      db.prepare(`
        UPDATE jobs
        SET status = ?, model = ?, prompt = ?, config_json = ?, result_json = ?,
            error = ?, project_id = ?, asset_id = ?, remote_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.status,
        next.model,
        next.prompt,
        toJson(next.config),
        toJson(next.result),
        next.error || "",
        next.projectId || "",
        next.assetId || "",
        next.remoteId || "",
        now(),
        id
      );
      this.touchProject(next.projectId || "");
      return this.getJob(id);
    },

    getJob(id) {
      return rowToJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
    },

    listJobs(limit = 80, projectId = null) {
      if (projectId === null || projectId === undefined) {
        return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit).map(rowToJob);
      }
      return db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId || "", limit).map(rowToJob);
    },

    listActiveVideoJobs() {
      return db.prepare(`
        SELECT * FROM jobs
        WHERE type = 'video' AND status IN ('queued', 'running', 'polling', 'saving')
        ORDER BY created_at ASC
      `).all().map(rowToJob);
    },

    createAsset(asset) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO assets (
          id, kind, mime, path, filename, source, prompt, model,
          job_id, project_id, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        asset.id,
        asset.kind,
        asset.mime,
        asset.path,
        asset.filename,
        asset.source || "",
        asset.prompt || "",
        asset.model || "",
        asset.jobId || "",
        asset.projectId || "",
        toJson(asset.metadata),
        timestamp,
        timestamp
      );
      this.touchProject(asset.projectId || "");
      return this.getAsset(asset.id);
    },

    updateAsset(id, patch) {
      const current = this.getAsset(id);
      if (!current) return null;
      const next = {
        ...current,
        ...patch,
        metadata: patch.metadata === undefined ? current.metadata : patch.metadata
      };
      db.prepare(`
        UPDATE assets
        SET source = ?, prompt = ?, model = ?, project_id = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.source || "",
        next.prompt || "",
        next.model || "",
        next.projectId || "",
        toJson(next.metadata),
        now(),
        id
      );
      this.touchProject(next.projectId || "");
      return this.getAsset(id);
    },

    getAsset(id) {
      return rowToAsset(db.prepare("SELECT * FROM assets WHERE id = ?").get(id));
    },

    listAssets(limit = 120, projectId = null) {
      if (projectId === null || projectId === undefined) {
        return db.prepare("SELECT * FROM assets ORDER BY created_at DESC LIMIT ?").all(limit).map(rowToAsset);
      }
      return db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId || "", limit).map(rowToAsset);
    },

    createShot(shot) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO shots (
          id, project_id, shot_index, shot_id, title, visual_prompt, video_prompt,
          camera, action, audio, negative_prompt, status, image_asset_id,
          video_job_id, video_asset_id, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shot.id,
        shot.projectId || "",
        shot.shotIndex || 0,
        shot.shotId || "",
        shot.title || "",
        shot.visualPrompt || "",
        shot.videoPrompt || "",
        shot.camera || "",
        shot.action || "",
        shot.audio || "",
        shot.negativePrompt || "",
        shot.status || "draft",
        shot.imageAssetId || "",
        shot.videoJobId || "",
        shot.videoAssetId || "",
        toJson(shot.metadata),
        timestamp,
        timestamp
      );
      this.touchProject(shot.projectId || "");
      return this.getShot(shot.id);
    },

    replaceProjectShots(projectId, shots) {
      const project = projectId || "";
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM shots WHERE project_id = ?").run(project);
        const created = [];
        for (const shot of shots) {
          created.push(this.createShot({ ...shot, projectId: project }));
        }
        this.touchProject(project);
        db.exec("COMMIT");
        return created;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    updateShot(id, patch) {
      const current = this.getShot(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      db.prepare(`
        UPDATE shots
        SET project_id = ?, shot_index = ?, shot_id = ?, title = ?,
            visual_prompt = ?, video_prompt = ?, camera = ?, action = ?,
            audio = ?, negative_prompt = ?, status = ?, image_asset_id = ?,
            video_job_id = ?, video_asset_id = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.projectId || "",
        next.shotIndex || 0,
        next.shotId || "",
        next.title || "",
        next.visualPrompt || "",
        next.videoPrompt || "",
        next.camera || "",
        next.action || "",
        next.audio || "",
        next.negativePrompt || "",
        next.status || "draft",
        next.imageAssetId || "",
        next.videoJobId || "",
        next.videoAssetId || "",
        toJson(next.metadata),
        now(),
        id
      );
      this.touchProject(next.projectId || "");
      return this.getShot(id);
    },

    getShot(id) {
      return rowToShot(db.prepare("SELECT * FROM shots WHERE id = ?").get(id));
    },

    listShots(projectId = null, limit = 200) {
      if (projectId === null || projectId === undefined) {
        return db.prepare("SELECT * FROM shots ORDER BY updated_at DESC LIMIT ?").all(limit).map(rowToShot);
      }
      return db.prepare(`
        SELECT * FROM shots
        WHERE project_id = ?
        ORDER BY shot_index ASC, created_at ASC
        LIMIT ?
      `).all(projectId || "", limit).map(rowToShot);
    }
  };
}

module.exports = { createDatabase, createStore };
