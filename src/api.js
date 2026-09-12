/* 统一的前端接口层：同一套界面分别跑在 Tauri / Electron / 浏览器里。
   Tauri 相关模块按需动态加载，避免另外两种环境加载到不存在的宿主对象。 */

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
const electronApi = typeof window !== 'undefined' ? window.ncmStudio : null;

let bridgePromise = null;
function tauri() {
  if (!bridgePromise) {
    bridgePromise = Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/window'),
      import('@tauri-apps/plugin-dialog')
    ]).then(([core, event, windowApi, dialog]) => ({
      invoke: core.invoke,
      listen: event.listen,
      getCurrentWindow: windowApi.getCurrentWindow,
      open: dialog.open
    }));
  }
  return bridgePromise;
}

const tauriApi = {
  async chooseFiles() {
    const { open } = await tauri();
    const result = await open({ multiple: true, filters: [{ name: '音频加密文件', extensions: ['ncm'] }] });
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  },
  async chooseFolder(initial) {
    const { open } = await tauri();
    const result = await open({ directory: true, defaultPath: initial || undefined });
    return result || null;
  },
  filePathsFromDrop() {
    return [];
  },
  async fileDetails(paths) {
    const { invoke } = await tauri();
    return invoke('file_details', { paths });
  },
  async revealFile(filePath) {
    const { invoke } = await tauri();
    return invoke('reveal_file', { path: filePath });
  },
  async getSettings() {
    const { invoke } = await tauri();
    return invoke('get_settings');
  },
  async saveSettings(settings) {
    const { invoke } = await tauri();
    return invoke('save_settings', { settings });
  },
  setTheme(theme) {
    tauri()
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === 'dark' ? 'dark' : 'light'))
      .catch(() => {});
  },
  async scan(folder) {
    const { invoke } = await tauri();
    return invoke('scan', { folder: folder || null });
  },
  async convert(files, settings) {
    const { invoke } = await tauri();
    return invoke('convert', {
      files: files.map((file) => ({ id: file.id, path: file.path, size: file.size || 0, modified: file.modified || 0 })),
      settings
    });
  },
  async cancel() {
    const { invoke } = await tauri();
    return invoke('cancel_convert');
  },
  async openFolder(folder) {
    const { invoke } = await tauri();
    return invoke('open_folder', { folder: folder || '' });
  },
  async openLicenses() {
    const { invoke } = await tauri();
    return invoke('open_licenses');
  },
  onScanProgress() {
    return () => {};
  },
  onConvertProgress(callback) {
    let dispose = null;
    let cancelled = false;
    tauri()
      .then(({ listen }) => listen('convert:progress', (event) => callback(event.payload)))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (dispose) dispose();
    };
  },
  async subscribeFileDrop(callback) {
    const { getCurrentWindow } = await tauri();
    return getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload?.type === 'drop' && event.payload.paths?.length) callback(event.payload.paths);
    });
  },
  notifyUiReady(probe) {
    tauri().then(({ invoke }) => invoke('ui_ready', { shell, probe })).catch(() => {});
  }
};

const browserMock = {
  chooseFiles: async () => [],
  chooseFolder: async () => null,
  filePathsFromDrop: () => [],
  fileDetails: async () => [],
  revealFile: async () => true,
  getSettings: async () => ({ outputDirectory: 'C:\\Users\\User\\Music\\NCM Studio', format: 'auto', mp3Bitrate: '320k', conflict: 'rename', naming: '{title}', scanOnLaunch: false, revealAfterComplete: false, organize: false, theme: 'system' }),
  saveSettings: async (settings) => settings,
  setTheme: () => {},
  scan: async () => ({ files: [], roots: 0 }),
  convert: async () => ({ results: [] }),
  cancel: async () => true,
  openFolder: async () => '',
  openLicenses: async () => '',
  onScanProgress: () => () => {},
  onConvertProgress: () => () => {},
  subscribeFileDrop: async () => () => {}
};

export const api = isTauri ? tauriApi : (electronApi || browserMock);
export const isDesktopShell = isTauri || Boolean(electronApi);
/* 宿主能力：Tauri 版只做「跟随原格式」输出，不做转码；Electron 版可转码 */
export const shell = isTauri ? 'tauri' : (electronApi ? 'electron' : 'browser');
export const supportsTranscode = !isTauri;
