const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { app, BrowserWindow, dialog, shell } = require("electron");

const HOST = "127.0.0.1";
const START_PORT = 4310;
const PORT_TRIES = 20;
const SERVER_READY_TIMEOUT_MS = 45000;
const APP_DISPLAY_NAME = "Gemini Relay Studio";

let mainWindow = null;
let serverProcess = null;
let stopping = false;
let activePort = START_PORT;
let mainLogFile = "";
let serverLogFile = "";

function writeMainLog(scope, message) {
  if (!mainLogFile) return;
  try {
    fs.mkdirSync(path.dirname(mainLogFile), { recursive: true });
    const text = String(message ?? "");
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return;
    const prefix = new Date().toISOString();
    const body = lines.map((line) => `${prefix} [${scope}] ${line}`).join("\n");
    fs.appendFileSync(mainLogFile, `${body}\n`, "utf8");
  } catch {
    // Do not break app startup on logging failures.
  }
}

function canListen(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, HOST);
  });
}

async function findAvailablePort(start, tries) {
  for (let index = 0; index < tries; index += 1) {
    const port = start + index;
    if (await canListen(port)) return port;
  }
  throw new Error(`No free port found in range ${start} - ${start + tries - 1}.`);
}

function runtimePaths() {
  const userDataDir = app.getPath("userData");
  const configDir = path.join(userDataDir, "config");
  const dataDir = path.join(userDataDir, "data");
  const logsDir = path.join(userDataDir, "logs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "assets"), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  return {
    configDir,
    dataDir,
    logsDir,
    mainLogFile: path.join(logsDir, "desktop.log"),
    serverLogFile: path.join(logsDir, "server.log")
  };
}

async function waitServerReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(
          {
            host: HOST,
            port: activePort,
            path: "/api/health",
            timeout: 2000
          },
          (response) => {
            response.resume();
            if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
              resolve();
              return;
            }
            reject(new Error(`Unexpected status ${response.statusCode || "unknown"}`));
          }
        );
        request.on("timeout", () => request.destroy(new Error("timeout")));
        request.on("error", reject);
      });
      return;
    } catch {
      // Keep polling until timeout.
    }
    await delay(300);
  }
  throw new Error("Local Gemini Relay Studio server did not become ready in time.");
}

function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  writeMainLog("app", "Stopping local server...");
  if (child.killed) return;
  child.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 2500);
  forceKillTimer.unref?.();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 1400,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://${HOST}:${activePort}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

async function startServer() {
  activePort = await findAvailablePort(START_PORT, PORT_TRIES);
  const appPath = app.getAppPath();
  const serverEntry = path.join(appPath, "server", "index.js");
  const { configDir, dataDir, mainLogFile: nextMainLogFile, serverLogFile: nextServerLogFile } = runtimePaths();
  mainLogFile = nextMainLogFile;
  serverLogFile = nextServerLogFile;
  writeMainLog("app", `Starting server on port ${activePort}`);
  writeMainLog("app", `Config dir: ${configDir}`);
  writeMainLog("app", `Data dir: ${dataDir}`);
  writeMainLog("app", `Server log file: ${serverLogFile}`);

  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(activePort),
      VEO3_CONFIG_DIR: configDir,
      VEO3_DATA_DIR: dataDir,
      VEO3_SERVER_LOG_FILE: serverLogFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(`[gemini-relay-server] ${text}`);
    writeMainLog("server.stdout", text);
  });
  serverProcess.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    process.stderr.write(`[gemini-relay-server] ${text}`);
    writeMainLog("server.stderr", text);
  });

  serverProcess.once("exit", (code, signal) => {
    writeMainLog("app", `Server exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (stopping) return;
    const reason = `本地服务已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`;
    if (mainWindow) {
      dialog.showErrorBox(`${APP_DISPLAY_NAME} 服务异常`, reason);
    }
    app.exit(1);
  });

  await waitServerReady(SERVER_READY_TIMEOUT_MS);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopping = true;
  stopServer();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});

app.setName(APP_DISPLAY_NAME);

app.whenReady()
  .then(async () => {
    await startServer();
    createWindow();
  })
  .catch((error) => {
    writeMainLog("app", `Startup failed: ${error?.stack || error?.message || String(error)}`);
    dialog.showErrorBox(`${APP_DISPLAY_NAME} 启动失败`, error?.message || String(error));
    app.exit(1);
  });
