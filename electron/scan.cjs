const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCAN_IGNORED = new Set(['node_modules', '$recycle.bin', 'system volume information', 'windows', '$windows.~bt', '$windows.~ws', 'recovery', 'perflogs', 'msocache', 'config.msi', 'program files', 'program files (x86)', 'programdata', 'drivers', 'installer']);
const MUSIC_FOLDER_HINT = /(cloudmusic|网易云|netease|vip\s*songs?|vipsongs)/i;
const SHALLOW_MUSIC_HINT = /^(music|音乐|我的音乐|my music)$/i;
const REGISTRY_FOLDER_HINT = /(cloudmusic|网易云音乐|vip\s*songs?\s*download|vipsongsdownload)/i;

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function isInside(target, folder) {
  const inner = path.resolve(target).toLowerCase().replace(/[\\/]+$/, '');
  const outer = path.resolve(folder).toLowerCase().replace(/[\\/]+$/, '');
  if (!inner || !outer) return false;
  return inner === outer || inner.startsWith(`${outer}\\`) || inner.startsWith(`${outer}/`);
}

function driveRoots() {
  const roots = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (isDirectory(root)) roots.push(root);
  }
  return roots;
}

/* 部分版本的网易云音乐会把自己设置的下载目录写进注册表 */
function registryMusicRoots() {
  const found = [];
  const keys = ['HKCU\\Software\\Netease\\CloudMusic', 'HKCU\\Software\\Netease\\Cloudmusic', 'HKCU\\Software\\Netease'];
  for (const key of keys) {
    let output = '';
    try { output = execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { continue; }
    for (const line of String(output).split(/\r?\n/)) {
      const match = /REG_(?:SZ|EXPAND_SZ)\s+(\S.*)$/.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^"|"$/g, '');
      if (value && REGISTRY_FOLDER_HINT.test(value) && isDirectory(value)) found.push(value);
    }
  }
  return found;
}

/* 网易云音乐常见的下载位置：用户目录 + 各磁盘根目录下的 CloudMusic 等 */
function builtinScanRoots(drives) {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Music'), path.join(home, 'Music', 'CloudMusic'), path.join(home, 'Music', 'VipSongsDownload'),
    path.join(home, 'Downloads'), path.join(home, 'CloudMusic'),
    path.join(home, 'Documents', '网易云音乐'), path.join(home, '音乐'),
    path.join(home, 'AppData', 'Local', 'Netease', 'CloudMusic'), path.join(home, 'AppData', 'Roaming', 'Netease', 'CloudMusic')
  ];
  for (const drive of drives) {
    roots.push(path.join(drive, 'CloudMusic'), path.join(drive, '网易云音乐'), path.join(drive, 'Music', 'CloudMusic'), path.join(drive, 'CloudMusic', 'VipSongsDownload'));
    roots.push(path.join(drive, 'Program Files', 'Netease', 'CloudMusic'), path.join(drive, 'Program Files (x86)', 'Netease', 'CloudMusic'));
  }
  roots.push(...registryMusicRoots());
  return roots.filter(isDirectory);
}

/* 在所有磁盘的浅层目录里寻找名字像网易云音乐下载目录的文件夹 */
async function discoverMusicFolders(drives, directoryBudget = 3200) {
  const budget = { left: directoryBudget };
  const searchOneDrive = async (root) => {
    const hits = [];
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length && budget.left > 0) {
      const { dir, depth } = queue.shift();
      budget.left -= 1;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        if (lower.startsWith('$') || SCAN_IGNORED.has(lower)) continue;
        const full = path.join(dir, entry.name);
        if (MUSIC_FOLDER_HINT.test(entry.name) || (depth === 0 && SHALLOW_MUSIC_HINT.test(entry.name))) hits.push(full);
        else if (depth + 1 < 3) queue.push({ dir: full, depth: depth + 1 });
      }
    }
    return hits;
  };
  const results = await Promise.all(drives.map(searchOneDrive));
  return results.flat();
}

function uniqueRoots(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = path.resolve(item).toLowerCase().replace(/[\\/]+$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* 去掉已经被上层目录覆盖的路径，避免同一个位置被重复扫描 */
function pruneNestedRoots(list) {
  const normalize = (value) => value.toLowerCase().replace(/[\\/]+$/, '');
  const sorted = [...list].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const item of sorted) {
    const lower = normalize(item);
    if (kept.some((root) => lower === normalize(root) || lower.startsWith(`${normalize(root)}\\`))) continue;
    kept.push(item);
  }
  return kept;
}

async function collectRoots({ customFolder, extraFolders = [], drives = driveRoots() } = {}) {
  if (customFolder) return { roots: isDirectory(customFolder) ? [customFolder] : [], drives };
  const known = uniqueRoots([...builtinScanRoots(drives), ...extraFolders].filter(isDirectory));
  const discovered = await discoverMusicFolders(drives);
  const roots = pruneNestedRoots(uniqueRoots([...known, ...discovered])).slice(0, 24);
  return { roots, drives };
}

async function collectNcmFiles(roots, { maxFiles = 5000, onProgress, exclude = [] } = {}) {
  const found = [];
  const seen = new Set();
  const skipped = exclude.filter(Boolean);
  for (const root of roots) {
    const stack = [root];
    while (stack.length && found.length < maxFiles) {
      const current = stack.pop();
      if (skipped.some((folder) => isInside(current, folder))) continue;
      let entries;
      try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SCAN_IGNORED.has(entry.name.toLowerCase())) stack.push(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ncm')) {
          const key = full.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const stat = await fs.promises.stat(full);
          found.push({ id: `${full}:${stat.mtimeMs}`, path: full, name: entry.name, size: stat.size, modified: stat.mtimeMs });
          if (onProgress) onProgress(found.length, current);
        }
        if (found.length >= maxFiles) break;
      }
    }
    if (found.length >= maxFiles) break;
  }
  return found;
}

module.exports = { SCAN_IGNORED, isDirectory, isInside, driveRoots, registryMusicRoots, builtinScanRoots, discoverMusicFolders, uniqueRoots, pruneNestedRoots, collectRoots, collectNcmFiles };
