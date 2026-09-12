const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { decodeFile, makeOutputName, parseNcm, safeName } = require('./ncm.cjs');
const { collectRoots, collectNcmFiles } = require('./scan.cjs');

let mainWindow;
let converting = false;
let cancelRequested = false;
let currentEncoder = null;
const defaultSettings = {
  outputDirectory: path.join(os.homedir(), 'Music', 'NCM Studio'),
  format: 'auto',
  mp3Bitrate: '320k',
  conflict: 'rename',
  naming: '{title}',
  scanOnLaunch: false,
  revealAfterComplete: false,
  organize: false,
  extraFolders: [],
  theme: 'system'
};

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    const settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
    if (settings.format === 'original') settings.format = 'auto';
    if (!['auto', 'mp3', 'flac'].includes(settings.format)) settings.format = 'auto';
    if (settings.formatMigrated !== true) { settings.format = 'auto'; settings.formatMigrated = true; }
    return settings;
  }
  catch { return { ...defaultSettings }; }
}
function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...defaultSettings, ...settings }, null, 2));
  return loadSettings();
}

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#f4f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f4f5f7', symbolColor: '#292d32', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });
  if (app.isPackaged) mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else mainWindow.loadURL('http://127.0.0.1:5173');

  if (process.env.NCM_STUDIO_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(() => {
          const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; };
          const barEl = document.querySelector('.window-bar');
          const bar = getComputedStyle(barEl);
          const actionbar = document.querySelector('.actionbar');
          return {
            title: document.title,
            text: document.body.innerText.slice(0, 400),
            hasRoot: document.getElementById('root')?.children.length > 0,
            theme: document.documentElement.dataset.theme,
            viewport: [innerWidth, innerHeight],
            bar: { rect: rect(barEl), background: bar.backgroundColor, borderBottom: bar.borderBottomWidth + ' ' + bar.borderBottomStyle, padding: bar.paddingLeft + ' / ' + bar.paddingRight },
            sidebar: document.querySelector('.sidebar') ? rect(document.querySelector('.sidebar')) : null,
            actionbar: actionbar ? rect(actionbar) : null
          };
        })()`);
        if (process.env.NCM_STUDIO_SMOKE_OUT) fs.writeFileSync(process.env.NCM_STUDIO_SMOKE_OUT, JSON.stringify(result));
        process.stdout.write(`${JSON.stringify(result)}\n`);
        app.exit(result.hasRoot && result.text.includes('音频转换') ? 0 : 2);
      } catch (error) {
        process.stderr.write(`${error.stack || error.message}\n`);
        app.exit(3);
      }
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('files:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{ name: '网易云音乐 NCM', extensions: ['ncm'] }] });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('folder:choose', async (_, initial) => {
  const result = await dialog.showOpenDialog(mainWindow, { defaultPath: initial || undefined, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_, settings) => saveSettings(settings));
ipcMain.on('window:theme', (_, theme) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const dark = theme === 'dark';
  mainWindow.setTitleBarOverlay({ color: dark ? '#181a1d' : '#f4f5f7', symbolColor: dark ? '#e5e7eb' : '#292d32', height: 44 });
});
ipcMain.handle('folder:open', async (_, folder) => {
  await fs.promises.mkdir(folder, { recursive: true });
  return shell.openPath(folder);
});
ipcMain.handle('app:open-licenses', async () => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'licenses'), path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.md')]
    : [path.join(__dirname, '..', 'licenses'), path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.md')];
  for (const target of candidates) { if (fs.existsSync(target)) return shell.openPath(target); }
  return '未找到许可文件';
});
ipcMain.handle('paths:from-files', (_, files) => files.map((file) => file.path).filter(Boolean));
ipcMain.handle('files:details', async (_, filePaths) => Promise.all(filePaths.filter((p) => p.toLowerCase().endsWith('.ncm')).map(async (filePath) => {
  const stat = await fs.promises.stat(filePath);
  let metadata = {};
  let coverDataUrl = null;
  try {
    const decoded = parseNcm(await fs.promises.readFile(filePath));
    metadata = decoded.metadata;
    if (decoded.coverData && decoded.coverData.length < 2_000_000) {
      const mime = decoded.coverData.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : 'image/jpeg';
      coverDataUrl = `data:${mime};base64,${decoded.coverData.toString('base64')}`;
    }
  } catch { /* details remain available even when metadata is damaged */ }
  return { id: `${filePath}:${stat.mtimeMs}`, path: filePath, name: path.basename(filePath), size: stat.size, modified: stat.mtimeMs, format: metadata.format || '', metadata, coverDataUrl };
})));
ipcMain.handle('file:reveal', async (_, filePath) => { shell.showItemInFolder(filePath); return true; });

ipcMain.handle('scan:start', async (_, customFolder) => {
  const settings = loadSettings();
  const { roots } = await collectRoots({ customFolder, extraFolders: settings.extraFolders || [] });
  if (mainWindow) mainWindow.webContents.send('scan:progress', { count: 0, current: '正在查找 NCM 文件…' });
  const files = await collectNcmFiles(roots, { maxFiles: 5000, exclude: [settings.outputDirectory], onProgress: (count, current) => { if (mainWindow) mainWindow.webContents.send('scan:progress', { count, current }); } });
  return { files, roots: roots.length };
});

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const executable = app.isPackaged ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
    const child = spawn(executable, args, { windowsHide: true });
    currentEncoder = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'progress') onProgress(value);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      currentEncoder = null;
      if (cancelRequested) reject(new Error('任务已停止'));
      else if (code === 0) resolve();
      else reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || `FFmpeg 退出码 ${code}`));
    });
  });
}

async function uniquePath(target, conflict) {
  try { await fs.promises.access(target); } catch { return target; }
  if (conflict === 'overwrite') return target;
  if (conflict === 'skip') return null;
  const ext = path.extname(target);
  const base = target.slice(0, -ext.length);
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    try { await fs.promises.access(candidate); } catch { return candidate; }
  }
  throw new Error('无法生成不重复的文件名');
}

ipcMain.handle('convert:cancel', () => {
  cancelRequested = true;
  if (currentEncoder && !currentEncoder.killed) currentEncoder.kill();
  return true;
});
ipcMain.handle('convert:start', async (_, { files, settings }) => {
  if (converting) throw new Error('已有转换任务正在运行');
  converting = true;
  cancelRequested = false;
  await fs.promises.mkdir(settings.outputDirectory, { recursive: true });
  const results = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (cancelRequested) break;
      const send = (payload) => mainWindow.webContents.send('convert:progress', { id: file.id, index, total: files.length, ...payload });
      send({ phase: 'decrypting', percent: 8, message: '正在读取并解密音频数据' });
      const tempBase = path.join(app.getPath('temp'), `ncm-studio-${process.pid}-${Date.now()}-${index}`);
      let decodedPath;
      try {
        const decoded = await decodeFile(file.path, tempBase);
        decodedPath = decoded.decodedPath;
          const targetFormat = settings.format === 'auto' ? decoded.format : settings.format;
        const outputName = makeOutputName(file.path, decoded.metadata, settings.naming);
        const targetDirectory = settings.organize ? path.join(settings.outputDirectory, safeName(decoded.metadata.artist) || '未知歌手', safeName(decoded.metadata.album) || '未知专辑') : settings.outputDirectory;
        await fs.promises.mkdir(targetDirectory, { recursive: true });
        const requested = path.join(targetDirectory, `${outputName}.${targetFormat}`);
        const outputPath = await uniquePath(requested, settings.conflict);
        if (!outputPath) {
          send({ phase: 'skipped', percent: 100, message: '目标文件已存在，已跳过' });
          results.push({ id: file.id, status: 'skipped' });
          await fs.promises.unlink(decodedPath).catch(() => {});
          continue;
        }
        send({ phase: 'converting', percent: 42, message: targetFormat === decoded.format ? '正在写入音频文件' : `正在转换为 ${targetFormat.toUpperCase()}` });
        if (targetFormat === decoded.format) {
          if (settings.conflict === 'overwrite') await fs.promises.rm(outputPath, { force: true });
          await fs.promises.rename(decodedPath, outputPath).catch(async () => {
            await fs.promises.copyFile(decodedPath, outputPath);
            await fs.promises.unlink(decodedPath);
          });
        } else {
          const codecArgs = targetFormat === 'mp3' ? ['-codec:a', 'libmp3lame', '-b:a', settings.mp3Bitrate] : ['-codec:a', 'flac'];
          await runFfmpeg(['-y', '-i', decodedPath, ...codecArgs, '-map_metadata', '0', '-progress', 'pipe:1', '-nostats', outputPath], (state) => {
            if (state === 'continue') send({ phase: 'converting', percent: 70, message: `正在编码 ${targetFormat.toUpperCase()} 音频` });
          });
          await fs.promises.unlink(decodedPath).catch(() => {});
        }
        send({ phase: 'done', percent: 100, message: `已保存到 ${path.basename(outputPath)}`, outputPath });
          results.push({ id: file.id, status: 'done', outputPath, format: targetFormat });
      } catch (error) {
        if (decodedPath) await fs.promises.unlink(decodedPath).catch(() => {});
        const stopped = cancelRequested && error.message === '任务已停止';
        send({ phase: stopped ? 'skipped' : 'error', percent: 100, message: stopped ? '任务已停止' : error.message });
        results.push({ id: file.id, status: stopped ? 'skipped' : 'error', error: error.message });
      }
    }
  } finally {
    converting = false;
  }
  if (settings.revealAfterComplete && results.some((r) => r.status === 'done')) shell.openPath(settings.outputDirectory);
  return { results, cancelled: cancelRequested };
});
