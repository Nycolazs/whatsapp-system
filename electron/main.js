const { app, BrowserWindow, shell, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080/login';
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 8080);
const FRONTEND_HOST = process.env.FRONTEND_HOST || '127.0.0.1';
const WINDOW_TITLE = 'WhatsApp System';
const RUNTIME_HEADER = 'x-whatsapp-system-runtime';
const RUNTIME_HEADER_VALUE = 'electron';

let mainWindow = null;
let managedFrontendProcess = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOrigin(urlString) {
  try {
    const url = new URL(urlString);
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    return `http://${FRONTEND_HOST}:${FRONTEND_PORT}`;
  }
}

function installElectronRuntimeHeader(origin) {
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch (_) {
    originUrl = new URL(`http://${FRONTEND_HOST}:${FRONTEND_PORT}`);
  }

  const urlFilter = [`${originUrl.protocol}//${originUrl.host}/*`];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: urlFilter }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    requestHeaders[RUNTIME_HEADER] = RUNTIME_HEADER_VALUE;
    callback({ requestHeaders });
  });
}

function isFrontendReachable(origin) {
  return new Promise((resolve) => {
    const req = http.get(origin, (res) => {
      // Qualquer resposta HTTP já indica que o servidor está de pé.
      res.resume();
      resolve(true);
    });

    req.on('error', () => resolve(false));
    req.setTimeout(1300, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForFrontend(origin, timeoutMs = 25000) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isFrontendReachable(origin);
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await delay(350);
  }
  return false;
}

function getFrontendServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'frontend', 'server.js');
  }
  return path.join(__dirname, '..', 'frontend', 'server.js');
}

function startManagedFrontend() {
  const frontendServerPath = getFrontendServerPath();
  const cwd = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  managedFrontendProcess = spawn(process.execPath, [frontendServerPath], {
    cwd,
    env: {
      ...process.env,
      FRONTEND_PORT: String(FRONTEND_PORT),
      FRONTEND_HOST,
      FRONTEND_REQUIRE_ELECTRON: process.env.FRONTEND_REQUIRE_ELECTRON || '1',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'inherit',
  });
}

function stopManagedFrontend() {
  if (!managedFrontendProcess || managedFrontendProcess.killed) return;
  try {
    managedFrontendProcess.kill('SIGTERM');
  } catch (_) {}
}

async function ensureFrontend(origin) {
  const alreadyRunning = await isFrontendReachable(origin);
  if (alreadyRunning) return;

  startManagedFrontend();
  const becameReachable = await waitForFrontend(origin);
  if (!becameReachable) {
    throw new Error(`Não foi possível iniciar o frontend em ${origin}`);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(DEFAULT_FRONTEND_URL);
}

async function bootstrap() {
  const origin = parseOrigin(DEFAULT_FRONTEND_URL);
  await ensureFrontend(origin);
  createMainWindow();
}

app.whenReady().then(async () => {
  try {
    const origin = parseOrigin(DEFAULT_FRONTEND_URL);
    installElectronRuntimeHeader(origin);
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    } catch (_) {}
    await bootstrap();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[electron] Falha ao iniciar:', error.message || error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopManagedFrontend();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      await bootstrap();
    } catch (_) {
      app.quit();
    }
  }
});
