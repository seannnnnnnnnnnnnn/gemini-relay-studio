const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "desktop");
const APP_NAME = "Gemini Relay Studio";
const PROTECTED_PACKAGE_PATHS = [
  "/.env",
  "/.DS_Store",
  "/AGENTS.md",
  "/BOOTSTRAP.md",
  "/HEARTBEAT.md",
  "/IDENTITY.md",
  "/MEMORY.md",
  "/SOUL.md",
  "/TOOLS.md",
  "/USER.md",
  "/data",
  "/dist",
  "/frontend",
  "/mascot",
  "/memory",
  "/node_modules",
  "/node_runtime",
  "/scripts",
  "/tailscale-env-results"
];
const PACKAGE_IGNORE = [
  /^\/dist($|\/)/,
  /^\/data($|\/)/,
  /^\/frontend($|\/)/,
  /^\/memory($|\/)/,
  /^\/mascot($|\/)/,
  /^\/node_modules($|\/)/,
  /^\/node_runtime($|\/)/,
  /^\/scripts($|\/)/,
  /^\/tailscale-env-results($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.env$/,
  /^\/\.env\.example$/,
  /^\/\.DS_Store$/,
  /^\/\.gitignore$/,
  /^\/AGENTS\.md$/,
  /^\/BOOTSTRAP\.md$/,
  /^\/HEARTBEAT\.md$/,
  /^\/IDENTITY\.md$/,
  /^\/MEMORY\.md$/,
  /^\/SOUL\.md$/,
  /^\/TOOLS\.md$/,
  /^\/USER\.md$/,
  /^\/README\.md$/,
  /^\/_setup_node\.ps1$/,
  /^\/package-lock\.json$/,
  /^\/postcss\.config\.cjs$/,
  /^\/start\.bat$/,
  /^\/start\.sh$/,
  /^\/tailwind\.config\.cjs$/,
  /^\/vite\.config\.mjs$/
];
const KEEP_LOCALES = new Set(["zh-CN.pak", "en-US.pak"]);

const TARGETS = {
  mac: [
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" }
  ],
  win: [
    { platform: "win32", arch: "x64" }
  ],
  all: [
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "win32", arch: "x64" }
  ]
};

function parseTarget() {
  const arg = (process.argv[2] || "all").trim().toLowerCase();
  if (!TARGETS[arg]) {
    throw new Error(`Unknown target "${arg}". Use one of: mac, win, all.`);
  }
  return arg;
}

async function loadPackager() {
  const moduleRef = await import("@electron/packager");
  return moduleRef.packager || moduleRef.default;
}

function prepareOutput(targetItems) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const item of targetItems) {
    const folderName = `${APP_NAME}-${item.platform}-${item.arch}`;
    fs.rmSync(path.join(OUT_DIR, folderName), { recursive: true, force: true });
  }
}

function assertPackageIgnoreRules() {
  const misses = PROTECTED_PACKAGE_PATHS.filter((filePath) => !PACKAGE_IGNORE.some((pattern) => pattern.test(filePath)));
  if (misses.length) {
    throw new Error(`Package ignore rules do not cover protected paths: ${misses.join(", ")}`);
  }
}

function runArchiveCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Archive command failed: ${command} ${args.join(" ")}`);
  }
}

function archiveBuiltPath(appPath) {
  if (process.env.SKIP_DESKTOP_ZIP === "1") return null;
  const folderName = path.basename(appPath);
  const zipPath = `${appPath}.zip`;
  const zipName = path.basename(zipPath);
  fs.rmSync(zipPath, { force: true });

  if (process.platform === "win32") {
    runArchiveCommand("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -Path ${JSON.stringify(folderName)} -DestinationPath ${JSON.stringify(zipName)} -Force`
    ], OUT_DIR);
    return zipPath;
  }

  const hasDitto = spawnSync("which", ["ditto"], { stdio: "ignore" }).status === 0;
  if (folderName.includes("-darwin-") && hasDitto) {
    runArchiveCommand("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", folderName, zipName], OUT_DIR);
  } else {
    runArchiveCommand("zip", ["-qry", zipName, folderName], OUT_DIR);
  }
  return zipPath;
}

function pruneLocales(rootPath) {
  const visited = [];
  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(dirPath, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "locales") {
        visited.push(nextPath);
        continue;
      }
      walk(nextPath);
    }
  }

  walk(rootPath);
  for (const localeDir of visited) {
    for (const entry of fs.readdirSync(localeDir, { withFileTypes: true })) {
      if (!entry.isFile() || KEEP_LOCALES.has(entry.name)) continue;
      fs.rmSync(path.join(localeDir, entry.name), { force: true });
    }
  }
}

async function main() {
  const target = parseTarget();
  const packager = await loadPackager();
  const targetItems = TARGETS[target];
  assertPackageIgnoreRules();
  prepareOutput(targetItems);

  const builtPaths = [];
  const archivePaths = [];
  for (const item of targetItems) {
    const appPaths = await packager({
      dir: ROOT,
      out: OUT_DIR,
      name: APP_NAME,
      platform: item.platform,
      arch: item.arch,
      overwrite: true,
      prune: true,
      asar: true,
      executableName: APP_NAME,
      ignore: PACKAGE_IGNORE,
      afterComplete: [
        async ({ buildPath }) => {
          pruneLocales(buildPath);
        }
      ]
    });
    builtPaths.push(...appPaths);
    for (const appPath of appPaths) {
      const archivePath = archiveBuiltPath(appPath);
      if (archivePath) archivePaths.push(archivePath);
    }
  }

  console.log("Desktop package finished:");
  for (const appPath of builtPaths) {
    console.log(`- ${appPath}`);
  }
  if (archivePaths.length) {
    console.log("Archives:");
    for (const archivePath of archivePaths) {
      console.log(`- ${archivePath}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
