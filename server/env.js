const fs = require("node:fs");
const path = require("node:path");

function envFilePath(rootDir) {
  const baseDir = process.env.VEO3_CONFIG_DIR
    ? path.resolve(process.env.VEO3_CONFIG_DIR)
    : rootDir;
  return path.join(baseDir, ".env");
}

function loadEnv(rootDir) {
  const envPath = envFilePath(rootDir);
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeEnvValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@?&=,+-]*$/.test(text)) return text;
  return JSON.stringify(text);
}

function updateEnvFile(rootDir, updates) {
  const envPath = envFilePath(rootDir);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (!match) return line;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
    seen.add(key);
    return `${key}=${escapeEnvValue(updates[key])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${escapeEnvValue(value)}`);
  }

  fs.writeFileSync(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value ?? "");
  }
}

module.exports = { loadEnv, env, envInt, updateEnvFile };
