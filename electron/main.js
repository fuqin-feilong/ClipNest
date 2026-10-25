'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  globalShortcut,
  ipcMain,
  screen,
  nativeImage,
  shell,
  protocol,
  net,
  session,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const APP_NAME = 'ClipNest';
const APP_ID = 'com.clipnest.app';
const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 640;
const POLL_INTERVAL = 500;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_HTML_CHARS = 300_000;
const MAX_IMAGE_MB = 30;
const MAX_IMAGE_EDGE = 4096;
const MAX_PREVIEW_CHARS = 40_000;
const IMAGE_PROTOCOL = 'clipimg';

const DEFAULT_SETTINGS = {
  theme: 'system',
  hotkey: 'Alt+V',
  maxItems: 500,
  retentionDays: 0,
  autoStart: false,
  pasteOnSelect: false,
  richText: true,
  captureImages: true,
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
protocol.registerSchemesAsPrivileged([
  {
    scheme: IMAGE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let dataDir = '';
let imagesDir = '';
let historyPath = '';
let settingsPath = '';
let logPath = '';
let images = [];
let settings = { ...DEFAULT_SETTINGS };
let paused = false;
let isQuitting = false;
let firstRun = false;

let tray = null;
let panel = null;
let trayMenu = null;
let pollTimer = null;
let clipboardBusy = false;
let lastClipboardSignature = null;
let lastClipboardSequence = null;
let getClipboardSequence = null;
let lastWrittenSignature = null;
let suppressUntil = 0;
let hotkeySuspended = false;
let activeHotkey = null;
let lastTrayClickAt = 0;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')}\n`;
  if (!app.isPackaged) {
    process.stdout.write(line);
  }
  if (!logPath) return;
  try {
    const stat = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
    if (stat && stat.size > 512 * 1024) {
      fs.rmSync(logPath, { force: true });
    }
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // Logging must never break the app.
  }
}

let clipboardUser32 = null;

function setupClipboardSequence() {
  if (process.platform !== 'win32') return;
  try {
    // Windows increments this counter whenever the clipboard changes. Reading it
    // is effectively free, so idle polling never has to decode image data.
    const koffi = require('koffi');
    clipboardUser32 = koffi.load('user32.dll');
    getClipboardSequence = clipboardUser32.func(
      'uint32_t __stdcall GetClipboardSequenceNumber(void)',
    );
    const value = getClipboardSequence();
    log('Clipboard sequence monitoring enabled', value);
  } catch (error) {
    clipboardUser32 = null;
    getClipboardSequence = null;
    log('Clipboard sequence monitoring unavailable', error.message);
  }
}

function currentClipboardSequence() {
  if (!getClipboardSequence) return null;
  try {
    const value = getClipboardSequence();
    return typeof value === 'number' ? value : null;
  } catch {
    getClipboardSequence = null;
    return null;
  }
}

function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log('Failed to read JSON', file, error.message);
    try {
      if (fs.existsSync(file)) {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    } catch {
      // Ignore backup errors.
    }
    return fallback;
  }
}

function atomicWriteJSON(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(temp, file);
  }
}

function setupPaths() {
  dataDir = app.getPath('userData');
  imagesDir = path.join(dataDir, 'images');
  historyPath = path.join(dataDir, 'history.json');
  settingsPath = path.join(dataDir, 'settings.json');
  logPath = path.join(dataDir, 'clipnest.log');
  fs.mkdirSync(imagesDir, { recursive: true });
  firstRun = !fs.existsSync(historyPath) && !fs.existsSync(settingsPath);
}

function normalizeSettings(value) {
  const next = { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== 'object') return next;

  if (['system', 'light', 'dark'].includes(value.theme)) next.theme = value.theme;
  if (typeof value.hotkey === 'string' && value.hotkey.trim()) next.hotkey = value.hotkey.trim();
  if ([100, 300, 500, 1000, 2000].includes(Number(value.maxItems))) {
    next.maxItems = Number(value.maxItems);
  }
  if ([0, 1, 7, 30, 90].includes(Number(value.retentionDays))) {
    next.retentionDays = Number(value.retentionDays);
  }
  if (typeof value.autoStart === 'boolean') next.autoStart = value.autoStart;
  if (typeof value.pasteOnSelect === 'boolean') next.pasteOnSelect = value.pasteOnSelect;
  if (typeof value.richText === 'boolean') next.richText = value.richText;
  if (typeof value.captureImages === 'boolean') next.captureImages = value.captureImages;
  return next;
}

function loadData() {
  settings = normalizeSettings(safeReadJSON(settingsPath, {}));
  const raw = safeReadJSON(historyPath, { version: 1, items: [] });
  const loaded = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : [];
  images = loaded
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
    .map((item) => {
      if (item.type === 'image') {
        if (!item.imageFile || !fs.existsSync(path.join(imagesDir, path.basename(item.imageFile)))) {
          return null;
        }
        return {
          id: item.id,
          type: 'image',
          signature: typeof item.signature === 'string' ? item.signature : `i:${item.id}`,
          imageFile: path.basename(item.imageFile),
          thumbFile: item.thumbFile ? path.basename(item.thumbFile) : path.basename(item.imageFile),
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
          bytes: Number(item.bytes) || 0,
          createdAt: Number(item.createdAt) || Date.now(),
          pinned: Boolean(item.pinned),
        };
      }
      if (typeof item.text !== 'string' || !item.text.trim()) return null;
      return {
        id: item.id,
        type: 'text',
        signature: typeof item.signature === 'string' ? item.signature : textSignature(item.text),
        text: item.text.slice(0, MAX_TEXT_CHARS),
        html: typeof item.html === 'string' ? item.html.slice(0, MAX_HTML_CHARS) : '',
        createdAt: Number(item.createdAt) || Date.now(),
        pinned: Boolean(item.pinned),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);

  pruneHistory({ save: false });
  atomicWriteJSON(historyPath, { version: 1, items: images });
  if (!fs.existsSync(settingsPath)) {
    atomicWriteJSON(settingsPath, settings);
  }
  log('Loaded data', { items: images.length, firstRun });
}

function saveSettings() {
  atomicWriteJSON(settingsPath, settings);
}

function saveHistory() {
  atomicWriteJSON(historyPath, { version: 1, items: images });
}

function textSignature(text) {
  return `t:${crypto.createHash('sha1').update(text, 'utf8').digest('hex')}`;
}

function imageSignature(image) {
  const size = image.getSize();
  const hash = crypto.createHash('sha1');
  hash.update(`${size.width}x${size.height}:`);
  hash.update(image.toBitmap());
  return `i:${hash.digest('hex')}`;
}

function makeId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function safeUnlink(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

function removeItemFiles(item) {
  if (!item || item.type !== 'image') return;
  if (item.imageFile) safeUnlink(path.join(imagesDir, path.basename(item.imageFile)));
  if (item.thumbFile && item.thumbFile !== item.imageFile) {
    safeUnlink(path.join(imagesDir, path.basename(item.thumbFile)));
  }
}

function pruneHistory({ save = true } = {}) {
  const cutoff =
    settings.retentionDays > 0
      ? Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000
      : 0;
  const keep = [];
  let unpinnedCount = 0;
  let changed = false;

  for (const item of images) {
    const expired = cutoff > 0 && !item.pinned && item.createdAt < cutoff;
    const overflow = !item.pinned && unpinnedCount >= settings.maxItems;
    if (expired || overflow) {
      removeItemFiles(item);
      changed = true;
      continue;
    }
    if (!item.pinned) unpinnedCount += 1;
    keep.push(item);
  }

  images = keep;
  if (changed && save) saveHistory();
  return changed;
}

function publicItem(item) {
  if (item.type === 'image') {
    return {
      id: item.id,
      type: 'image',
      image: `${IMAGE_PROTOCOL}://local/${encodeURIComponent(item.imageFile)}`,
      preview: `${IMAGE_PROTOCOL}://local/${encodeURIComponent(item.thumbFile || item.imageFile)}`,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
      createdAt: item.createdAt,
      pinned: item.pinned,
      textLength: 0,
      rich: false,
    };
  }
  return {
    id: item.id,
    type: 'text',
    text: item.text.slice(0, MAX_PREVIEW_CHARS),
    truncated: item.text.length > MAX_PREVIEW_CHARS,
    textLength: item.text.length,
    rich: Boolean(item.html),
    createdAt: item.createdAt,
    pinned: item.pinned,
  };
}

function publicItems() {
  return images.map(publicItem);
}

function directorySize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        // Ignore files that disappear mid-scan.
      }
    }
  } catch {
    // Ignore inaccessible directories.
  }
  return total;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function appMeta() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    storageBytes:
      directorySize(imagesDir) +
      fileSize(historyPath) +
      fileSize(settingsPath) +
      fileSize(logPath),
    canAutoStart: app.isPackaged,
    hotkey: settings.hotkey,
    activeHotkey,
    hotkeyActive: Boolean(activeHotkey && globalShortcut.isRegistered(activeHotkey)),
    paused,
  };
}

function push(channel, payload) {
  if (!panel || panel.isDestroyed() || panel.webContents.isDestroyed()) return;
  panel.webContents.send(channel, payload);
}

function broadcastHistory() {
  push('history:changed', publicItems());
  push('app:meta', appMeta());
}

function broadcastSettings() {
  push('settings:changed', settings);
  push('app:meta', appMeta());
}

function broadcastPaused() {
  push('capture:paused', paused);
  push('app:meta', appMeta());
  refreshTrayMenu();
}

function createProtocolHandler() {
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      const fileName = path.basename(decodeURIComponent(url.pathname));
      const filePath = path.join(imagesDir, fileName);
      if (!filePath.startsWith(imagesDir + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      log('Image protocol error', error.message);
      return new Response('Not found', { status: 404 });
    }
  });
}

function getTrayIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.ico');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip(`${APP_NAME} · 点击打开剪贴板`);
  tray.on('click', () => {
    const now = Date.now();
    if (now - lastTrayClickAt < 250) return;
    lastTrayClickAt = now;
    togglePanel();
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  trayMenu = Menu.buildFromTemplate([
    {
      label: '打开 ClipNest',
      click: () => showPanel(),
    },
    {
      label: paused ? '恢复记录' : '暂停记录',
      type: 'checkbox',
      checked: paused,
      click: () => setPaused(!paused),
    },
    { type: 'separator' },
    {
      label: '清空历史…',
      enabled: images.length > 0,
      click: () => confirmClearFromTray(),
    },
    {
      label: '设置',
      click: () => {
        showPanel();
        push('panel:open-settings');
      },
    },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: settings.autoStart,
      enabled: app.isPackaged,
      click: (menuItem) => updateSettings({ autoStart: menuItem.checked }),
    },
    { type: 'separator' },
    {
      label: `版本 ${app.getVersion()}`,
      enabled: false,
    },
    {
      label: '退出 ClipNest',
      click: () => quitApp(),
    },
  ]);
  tray.setContextMenu(trayMenu);
  tray.setToolTip(
    paused
      ? `${APP_NAME} · 记录已暂停`
      : `${APP_NAME} · ${settings.hotkey || '无快捷键'} 打开`,
  );
}

function getPanelBounds() {
  const cursor = screen.getCursorScreenPoint();
  let display = screen.getDisplayNearestPoint(cursor);

  let anchor = null;
  try {
    if (tray) {
      const bounds = tray.getBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        anchor = bounds;
        display = screen.getDisplayNearestPoint({
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2),
        });
      }
    }
  } catch {
    anchor = null;
  }

  const area = display.workArea;
  const width = WINDOW_WIDTH;
  const height = WINDOW_HEIGHT;
  let x;
  let y;

  if (!anchor) {
    x = area.x + area.width - width - 12;
    y = area.y + area.height - height - 12;
  } else {
    x = Math.round(anchor.x + anchor.width / 2 - width / 2);
    const taskbarAtTop = anchor.y <= area.y + 4;
    const taskbarOnSide =
      anchor.x < area.x + area.width * 0.25 || anchor.x > area.x + area.width * 0.75;
    if (taskbarAtTop) {
      y = area.y + 10;
    } else if (taskbarOnSide) {
      y = Math.round(anchor.y + anchor.height / 2 - height / 2);
    } else {
      y = area.y + area.height - height - 10;
    }
  }

  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - height - 8));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function createPanel() {
  const devUrl =
    !app.isPackaged && process.argv.includes('--dev')
      ? 'http://localhost:5187'
      : null;
  panel = new BrowserWindow({
    ...getPanelBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    acceptFirstMouse: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
    },
  });

  panel.setMenuBarVisibility(false);
  panel.setAlwaysOnTop(true, 'pop-up-menu');

  panel.once('ready-to-show', () => {
    const shouldShow =
      (firstRun || process.argv.includes('--show')) &&
      !process.argv.includes('--hidden');
    if (shouldShow) {
      setTimeout(() => showPanel(), 220);
    }
  });

  if (devUrl) {
    panel.loadURL(devUrl);
  } else {
    panel.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  panel.on('blur', () => {
    setTimeout(() => {
      if (!panel || panel.isDestroyed() || isQuitting) return;
      if (panel.isFocused()) return;
      if (!panel.webContents.isDestroyed() && panel.webContents.isDevToolsFocused()) return;
      hidePanel();
    }, 130);
  });

  panel.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hidePanel();
    }
  });

  panel.webContents.on('render-process-gone', (_event, details) => {
    log('Renderer process gone', details.reason);
    if (!isQuitting && panel && !panel.isDestroyed()) {
      setTimeout(() => {
        if (panel && !panel.isDestroyed()) panel.reload();
      }, 400);
    }
  });

  panel.on('closed', () => {
    panel = null;
  });

  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file:');
    if (!allowed) event.preventDefault();
  });

  screen.on('display-metrics-changed', () => {
    if (panel && panel.isVisible()) panel.setBounds(getPanelBounds(), false);
  });
  screen.on('display-added', () => {
    if (panel && panel.isVisible()) panel.setBounds(getPanelBounds(), false);
  });
  screen.on('display-removed', () => {
    if (panel && panel.isVisible()) panel.setBounds(getPanelBounds(), false);
  });
}

function showPanel() {
  if (!panel || panel.isDestroyed()) return;
  panel.setBounds(getPanelBounds(), false);
  panel.show();
  panel.moveTop();
  panel.focus();
  push('panel:shown');
}

function hidePanel() {
  if (hotkeySuspended) {
    hotkeySuspended = false;
    registerHotkey(settings.hotkey, { silent: true });
  }
  if (panel && !panel.isDestroyed() && panel.isVisible()) {
    panel.hide();
  }
}

function togglePanel() {
  if (panel && panel.isVisible()) {
    hidePanel();
  } else {
    showPanel();
  }
}

async function confirmClearFromTray() {
  hidePanel();
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: '清空剪贴板历史',
    message: '确定要清空所有剪贴板历史吗？',
    detail: '包括已固定的项目。此操作无法撤销。',
    buttons: ['取消', '清空'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response === 1) {
    clearHistory();
  }
}

function registerHotkey(accelerator, { silent = false } = {}) {
  globalShortcut.unregisterAll();
  activeHotkey = null;
  if (!accelerator) {
    if (!silent) log('No hotkey configured');
    refreshTrayMenu();
    return false;
  }
  try {
    const ok = globalShortcut.register(accelerator, () => togglePanel());
    if (ok && globalShortcut.isRegistered(accelerator)) {
      activeHotkey = accelerator;
      hotkeySuspended = false;
      if (!silent) log('Registered hotkey', accelerator);
      refreshTrayMenu();
      return true;
    }
    log('Hotkey registration failed', accelerator);
  } catch (error) {
    log('Hotkey registration threw', accelerator, error.message);
  }
  if (!silent) refreshTrayMenu();
  return false;
}

function setPaused(value) {
  paused = Boolean(value);
  refreshClipboardBaseline();
  broadcastPaused();
  log('Capture paused', paused);
}

function refreshClipboardBaseline() {
  lastClipboardSequence = currentClipboardSequence();
  try {
    const formats = clipboard.availableFormats();
    if (settings.captureImages && hasImageFormat(formats)) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        lastClipboardSignature = imageSignature(image);
        return;
      }
    }
    const text = clipboard.readText();
    lastClipboardSignature = text && text.trim() ? textSignature(text) : null;
  } catch {
    lastClipboardSignature = null;
  }
}

function hasImageFormat(formats) {
  return formats.some((format) => {
    const value = String(format).toLowerCase();
    return (
      value === 'image/png' ||
      value === 'image/jpeg' ||
      value === 'image/bmp' ||
      value.includes('cf_dib') ||
      value.includes('image/bitmap')
    );
  });
}

function readClipboardCandidate() {
  const formats = clipboard.availableFormats();

  if (settings.captureImages && hasImageFormat(formats)) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      return {
        type: 'image',
        image,
        signature: imageSignature(image),
      };
    }
  }

  const text = clipboard.readText();
  if (!text || !text.trim()) return null;
  if (text.length > MAX_TEXT_CHARS) {
    log('Skipped oversized text', { length: text.length });
    return null;
  }

  const html = formats.includes('text/html') ? clipboard.readHTML() : '';
  return {
    type: 'text',
    text,
    html: html ? html.slice(0, MAX_HTML_CHARS) : '',
    signature: textSignature(text),
  };
}

function persistImage(image) {
  const id = makeId();
  let png = image.toPNG();
  let storedImage = image;

  if (png.length > MAX_IMAGE_MB * 1024 * 1024) {
    const size = image.getSize();
    const largestEdge = Math.max(size.width, size.height);
    if (largestEdge > MAX_IMAGE_EDGE) {
      const scale = MAX_IMAGE_EDGE / largestEdge;
      storedImage = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best',
      });
      png = storedImage.toPNG();
    }
  }

  if (!png || png.length === 0) throw new Error('Image conversion returned no data');
  if (png.length > MAX_IMAGE_MB * 1024 * 1024) {
    throw new Error('Image is larger than the storage limit');
  }

  const imageFile = `${id}.png`;
  const thumbFile = `${id}.thumb.jpg`;
  const fullPath = path.join(imagesDir, imageFile);
  const thumbPath = path.join(imagesDir, thumbFile);
  const size = storedImage.getSize();

  const tempFull = `${fullPath}.tmp`;
  fs.writeFileSync(tempFull, png);
  fs.renameSync(tempFull, fullPath);

  const thumbSource = size.width > 720
    ? storedImage.resize({ width: 720, quality: 'good' })
    : storedImage;
  fs.writeFileSync(thumbPath, thumbSource.toJPEG(84));

  return {
    imageFile,
    thumbFile,
    width: size.width,
    height: size.height,
    bytes: png.length,
  };
}

function upsertClipboardItem(candidate) {
  const existingIndex = images.findIndex((item) => item.signature === candidate.signature);
  if (existingIndex >= 0) {
    const [existing] = images.splice(existingIndex, 1);
    existing.createdAt = Date.now();
    if (existing.type === 'text' && candidate.type === 'text' && candidate.html) {
      existing.html = candidate.html;
    }
    images.unshift(existing);
    saveHistory();
    broadcastHistory();
    return existing;
  }

  let item;
  if (candidate.type === 'image') {
    const stored = persistImage(candidate.image);
    item = {
      id: makeId(),
      type: 'image',
      signature: candidate.signature,
      ...stored,
      createdAt: Date.now(),
      pinned: false,
    };
  } else {
    item = {
      id: makeId(),
      type: 'text',
      signature: candidate.signature,
      text: candidate.text,
      html: settings.richText ? candidate.html : '',
      createdAt: Date.now(),
      pinned: false,
    };
  }

  images.unshift(item);
  pruneHistory({ save: false });
  saveHistory();
  broadcastHistory();
  log('Captured item', { type: item.type, length: item.text ? item.text.length : item.bytes });
  return item;
}

function pollClipboard() {
  if (paused || clipboardBusy || !app.isReady()) return;
  const sequence = currentClipboardSequence();
  const hasSequence = sequence !== null;
  if (hasSequence && sequence === lastClipboardSequence) return;
  clipboardBusy = true;
  try {
    const candidate = readClipboardCandidate();
    if (hasSequence) lastClipboardSequence = sequence;
    if (!candidate) {
      lastClipboardSignature = null;
      return;
    }
    if (!hasSequence && candidate.signature === lastClipboardSignature) return;

    if (
      !hasSequence &&
      Date.now() < suppressUntil &&
      lastWrittenSignature &&
      candidate.signature === lastWrittenSignature
    ) {
      lastClipboardSignature = candidate.signature;
      return;
    }

    lastClipboardSignature = candidate.signature;
    upsertClipboardItem(candidate);
  } catch (error) {
    if (hasSequence) lastClipboardSequence = null;
    log('Clipboard capture failed', error.message);
  } finally {
    clipboardBusy = false;
  }
}

function copyItemToClipboard(item, { plain = false } = {}) {
  if (!item) return false;
  if (item.type === 'image') {
    const fullPath = path.join(imagesDir, path.basename(item.imageFile));
    if (!fs.existsSync(fullPath)) return false;
    const image = nativeImage.createFromPath(fullPath);
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
  } else {
    const payload = { text: item.text };
    if (!plain && settings.richText && item.html) payload.html = item.html;
    clipboard.write(payload);
  }
  lastClipboardSequence = currentClipboardSequence();
  lastClipboardSignature = item.signature;
  lastWrittenSignature = item.signature;
  suppressUntil = Date.now() + 1800;
  return true;
}

function pasteIntoPreviousWindow() {
  setTimeout(() => {
    const script =
      "$ws = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $ws.SendKeys('^v')";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 5000 },
      (error) => {
        if (error) log('Auto paste failed', error.message);
      },
    );
  }, 210);
}

function getItemById(id) {
  if (typeof id !== 'string') return null;
  return images.find((item) => item.id === id) || null;
}

function clearHistory() {
  images.forEach(removeItemFiles);
  images = [];
  try {
    fs.rmSync(imagesDir, { recursive: true, force: true });
    fs.mkdirSync(imagesDir, { recursive: true });
  } catch (error) {
    log('Failed to clear image folder', error.message);
  }
  saveHistory();
  broadcastHistory();
  refreshTrayMenu();
  log('History cleared');
}

function updateSettings(patch) {
  const previous = { ...settings };
  const next = { ...settings };

  if (!patch || typeof patch !== 'object') return { ok: false, error: '无效设置' };
  if ('theme' in patch) {
    if (!['system', 'light', 'dark'].includes(patch.theme)) {
      return { ok: false, error: '无效主题' };
    }
    next.theme = patch.theme;
  }
  if ('maxItems' in patch) {
    const value = Number(patch.maxItems);
    if (![100, 300, 500, 1000, 2000].includes(value)) {
      return { ok: false, error: '无效的历史条数' };
    }
    next.maxItems = value;
  }
  if ('retentionDays' in patch) {
    const value = Number(patch.retentionDays);
    if (![0, 1, 7, 30, 90].includes(value)) {
      return { ok: false, error: '无效的保留天数' };
    }
    next.retentionDays = value;
  }
  if ('pasteOnSelect' in patch) next.pasteOnSelect = Boolean(patch.pasteOnSelect);
  if ('richText' in patch) next.richText = Boolean(patch.richText);
  if ('captureImages' in patch) next.captureImages = Boolean(patch.captureImages);
  if ('autoStart' in patch) {
    const result = applyAutoStart(Boolean(patch.autoStart));
    if (!result.ok) return result;
    next.autoStart = result.enabled;
  }

  settings = next;
  saveSettings();
  if (previous.maxItems !== settings.maxItems || previous.retentionDays !== settings.retentionDays) {
    pruneHistory({ save: true });
    broadcastHistory();
  }
  broadcastSettings();
  refreshTrayMenu();
  return { ok: true, settings, meta: appMeta() };
}

function applyAutoStart(enabled) {
  if (!app.isPackaged) {
    return { ok: false, error: '开发模式下不支持开机启动，请使用安装版' };
  }
  try {
    const executablePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: executablePath,
    });
    const actual = app.getLoginItemSettings({
      path: executablePath,
    });
    return { ok: true, enabled: Boolean(actual.openAtLogin) };
  } catch (error) {
    log('Auto start update failed', error.message);
    return { ok: false, error: '无法修改开机启动设置' };
  }
}

function quitApp() {
  isQuitting = true;
  if (panel && !panel.isDestroyed()) panel.destroy();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}

function setupIpc() {
  ipcMain.handle('app:get-state', () => ({
    items: publicItems(),
    settings,
    meta: appMeta(),
  }));

  ipcMain.handle('history:copy', (_event, payload = {}) => {
    const item = getItemById(payload.id);
    if (!item) return { ok: false, error: '内容不存在或已被删除' };
    const plain = Boolean(payload.plain);
    const shouldPaste = Boolean(payload.paste) || settings.pasteOnSelect;
    try {
      if (!copyItemToClipboard(item, { plain })) {
        return { ok: false, error: '复制失败，文件可能已被清理' };
      }
    } catch (error) {
      log('Copy failed', error.message);
      return { ok: false, error: '复制失败' };
    }
    hidePanel();
    if (shouldPaste) pasteIntoPreviousWindow();
    return { ok: true };
  });

  ipcMain.handle('history:pin', (_event, id) => {
    const item = getItemById(id);
    if (!item) return { ok: false, error: '内容不存在' };
    item.pinned = !item.pinned;
    saveHistory();
    broadcastHistory();
    return { ok: true, pinned: item.pinned };
  });

  ipcMain.handle('history:delete', (_event, id) => {
    const index = images.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, error: '内容不存在' };
    const [removed] = images.splice(index, 1);
    removeItemFiles(removed);
    saveHistory();
    broadcastHistory();
    refreshTrayMenu();
    return { ok: true };
  });

  ipcMain.handle('history:clear', () => {
    clearHistory();
    return { ok: true };
  });

  ipcMain.handle('settings:update', (_event, patch) => updateSettings(patch));

  ipcMain.handle('hotkey:suspend', () => {
    hotkeySuspended = true;
    globalShortcut.unregisterAll();
    activeHotkey = null;
    push('app:meta', appMeta());
    return { ok: true };
  });

  ipcMain.handle('hotkey:resume', () => {
    hotkeySuspended = false;
    const ok = registerHotkey(settings.hotkey, { silent: true });
    push('app:meta', appMeta());
    return { ok };
  });

  ipcMain.handle('hotkey:set', (_event, accelerator) => {
    if (typeof accelerator !== 'string' || !accelerator.trim() || accelerator.length > 80) {
      return { ok: false, error: '无效的快捷键' };
    }
    const previous = settings.hotkey;
    const next = accelerator.trim();
    globalShortcut.unregisterAll();
    activeHotkey = null;
    let registered = false;
    try {
      registered = globalShortcut.register(next, () => togglePanel());
    } catch {
      registered = false;
    }
    if (!registered) {
      registerHotkey(previous, { silent: true });
      push('app:meta', appMeta());
      return { ok: false, error: '该快捷键已被其他程序占用' };
    }
    settings.hotkey = next;
    hotkeySuspended = false;
    activeHotkey = next;
    saveSettings();
    broadcastSettings();
    refreshTrayMenu();
    log('Hotkey changed', next);
    return { ok: true, settings, meta: appMeta() };
  });

  ipcMain.handle('capture:toggle-pause', () => {
    setPaused(!paused);
    return { ok: true, paused };
  });

  ipcMain.handle('capture:set-pause', (_event, value) => {
    setPaused(Boolean(value));
    return { ok: true, paused };
  });

  ipcMain.handle('app:open-data', () => shell.openPath(dataDir));

  ipcMain.handle('app:hide-panel', () => {
    hidePanel();
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    quitApp();
  });
}

function registerIpcOnce() {
  if (registerIpcOnce.done) return;
  registerIpcOnce.done = true;
  setupIpc();
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (app.isReady()) showPanel();
  });

  app.whenReady().then(() => {
    try {
      setupPaths();
      loadData();
      createProtocolHandler();
      registerIpcOnce();
      setupClipboardSequence();

      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
        callback(false);
      });

      createTray();
      createPanel();
      registerHotkey(settings.hotkey);
      if (app.isPackaged) {
        const autostart = applyAutoStart(settings.autoStart);
        if (!autostart.ok && settings.autoStart) {
          settings.autoStart = false;
          saveSettings();
        }
      }

      refreshClipboardBaseline();
      pollTimer = setInterval(pollClipboard, POLL_INTERVAL);
      if (pollTimer.unref) pollTimer.unref();

      app.on('activate', () => showPanel());
      log('ClipNest started', {
        version: app.getVersion(),
        packaged: app.isPackaged,
        dataDir,
      });
    } catch (error) {
      log('Fatal startup error', error.stack || error.message);
      dialog.showErrorBox(
        'ClipNest 启动失败',
        `应用初始化时遇到问题：\n${error.message}\n\n日志：${logPath || dataDir}`,
      );
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  // Keep running in the tray until the user explicitly quits.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  globalShortcut.unregisterAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

process.on('uncaughtException', (error) => {
  log('Uncaught exception', error.stack || error.message);
});
process.on('unhandledRejection', (error) => {
  log('Unhandled rejection', error && (error.stack || error.message));
});
