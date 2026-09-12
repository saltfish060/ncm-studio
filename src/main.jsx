import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchiveRestore, Check, CircleAlert, FileAudio, FileText, FolderOpen, History, ListMusic, Moon, Music2, Plus, Search, Settings, Sun, Trash2, X } from 'lucide-react';
import './styles.css';
import { api, shell, supportsTranscode } from './api.js';

/* 让样式知道当前跑在哪个宿主里：Tauri 用系统标题栏，不需要自绘那条 */
if (typeof document !== 'undefined') document.documentElement.dataset.shell = shell;

const EMPTY_SETTINGS = { outputDirectory: '', format: 'auto', mp3Bitrate: '320k', conflict: 'rename', naming: '{title}', scanOnLaunch: false, revealAfterComplete: false, organize: false, theme: 'system' };

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function Sidebar({ view, setView, count, historyCount, onNavigate }) {
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark"><Music2 size={19} strokeWidth={2.4}/></span><span>NCM Studio</span>{shell !== 'browser' && <i className="brand-tag">{shell === 'tauri' ? 'Rust' : 'Electron'}</i>}</div>
    <nav>
      <button className={view === 'convert' ? 'nav-active' : ''} onClick={() => setView('convert')}><ListMusic size={18}/><span>转换列表</span>{count > 0 && <b>{count}</b>}</button>
      <button className={view === 'history' ? 'nav-active' : ''} onClick={() => onNavigate('history')}><History size={18}/><span>转换记录</span>{historyCount > 0 && <b>1</b>}</button>
      <button className={view === 'settings' ? 'nav-active' : ''} onClick={() => onNavigate('settings')}><Settings size={18}/><span>设置</span></button>
    </nav>
    <div className="privacy"><ArchiveRestore size={17}/><div><strong>仅在本地处理</strong><span>音频不会上传到网络</span></div></div>
  </aside>;
}

function DropZone({ onPaths, scanning, onScan }) {
  const [dragging, setDragging] = useState(false);
  const onPathsRef = useRef(onPaths);
  onPathsRef.current = onPaths;
  useEffect(() => {
    let dispose = null;
    let cancelled = false;
    if (api.subscribeFileDrop) {
      api.subscribeFileDrop((paths) => {
        if (paths?.length) onPathsRef.current(paths);
      }).then((unlisten) => { if (cancelled) unlisten(); else dispose = unlisten; }).catch(() => {});
    }
    return () => { cancelled = true; if (dispose) dispose(); };
  }, []);
  const drop = (event) => {
    event.preventDefault(); setDragging(false);
    onPaths(api.filePathsFromDrop([...event.dataTransfer.files]));
  };
  return <section className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <div className="drop-icon"><FileAudio size={28}/><span><Plus size={13}/></span></div>
    <div className="drop-copy"><h2>拖入 NCM 文件</h2><p>支持一次添加多个文件，也可以从电脑中自动查找</p></div>
    <div className="drop-actions">
      <button className="primary" onClick={async () => onPaths(await api.chooseFiles())}><Plus size={17}/>添加文件</button>
      <button className="secondary" disabled={scanning} onClick={() => onScan()}><Search size={17}/>{scanning ? '正在查找…' : '自动查找'}</button>
    </div>
  </section>;
}

function StatusIcon({ phase }) {
  if (phase === 'done') return <span className="status-icon success"><Check size={15}/></span>;
  if (phase === 'error') return <span className="status-icon error"><CircleAlert size={15}/></span>;
  return <span className="filetype">NCM</span>;
}

function Queue({ files, remove, clear, clearCompleted, working, query, setQuery, filter, setFilter }) {
  if (!files.length) return <section className="empty"><FileAudio size={34}/><h3>还没有待转换文件</h3><p>添加文件或使用自动查找后，它们会出现在这里</p></section>;
  const visibleFiles = files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).filter((file) => filter === 'all' || (filter === 'done' ? file.phase === 'done' : file.phase !== 'done'));
  return <section className="queue">
    <header><div><h3>转换队列</h3><span>{files.length} 个文件 · {formatBytes(files.reduce((sum, f) => sum + f.size, 0))}</span></div><div className="queue-tools"><label className="queue-search"><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名"/></label><button className="text-button" disabled={working} onClick={clearCompleted}><Check size={15}/>清除已完成</button><button className="text-button" disabled={working} onClick={clear}><Trash2 size={15}/>清空</button></div></header>
    <div className="queue-filter"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <b>{files.length}</b></button><button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待处理 <b>{files.filter((f) => f.phase !== 'done').length}</b></button><button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>已完成 <b>{files.filter((f) => f.phase === 'done').length}</b></button></div>
    <div className="file-list">{visibleFiles.length ? visibleFiles.map((file) => <article className="file-row" key={file.id}>
      {file.coverDataUrl ? <img className="cover-thumb" src={file.coverDataUrl} alt=""/> : <StatusIcon phase={file.phase}/>}<div className="file-main"><div className="file-title"><strong title={file.path}>{file.metadata?.title || file.name}</strong><span>{file.metadata?.artist || '未知歌手'} · {formatBytes(file.size)}</span></div>
        <div className="progress-track"><i style={{ width: `${file.percent || 0}%` }} className={file.phase === 'error' ? 'failed' : ''}/></div>
        <p className={file.phase === 'error' ? 'message-error' : ''}>{file.message || '等待转换'}</p>
      </div>
      {!working && <div className="row-actions"><button className="icon-button" title="打开文件所在位置" onClick={() => api.revealFile(file.outputPath || file.path)}><FolderOpen size={16}/></button><button className="icon-button" title="移除" onClick={() => remove(file.id)}><X size={17}/></button></div>}
    </article>) : <div className="filtered-empty">没有匹配的文件</div>}</div>
  </section>;
}

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem('ncm-history') || '[]');
    return Array.isArray(saved) ? saved.map((item) => ({ ...item, batch: item.batch || item.id, at: item.at || null })) : [];
  } catch { return []; }
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function groupHistory(history) {
  const groups = [];
  for (const item of history) {
    const key = item.batch || item.id;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, at: item.at, fallbackTime: item.time, items: [item] });
  }
  return groups;
}

function HistoryPanel({ history, clear, highlightBatch }) {
  const groups = groupHistory(history);
  return <main className="settings-page history-page"><div className="page-heading"><h1>转换记录</h1><p>最近完成的本地转换任务</p></div>{groups.length ? <section className="settings-section history-list">{groups.map((group) => { const isRecent = Boolean(highlightBatch) && group.key === highlightBatch; return <div className={`history-group${isRecent ? ' recent' : ''}`} key={group.key}><div className="history-group-head"><span>{formatDateTime(group.at) || group.fallbackTime}</span><span>{group.items.length} 个文件</span>{isRecent && <span className="recent-label">上一次转换</span>}</div>{group.items.map((item) => <div className="history-item" key={item.id}><span className="status-icon success"><Check size={15}/></span><div className="history-main"><strong>{item.name}</strong><small>{item.format}</small></div></div>)}</div>; })}<button className="text-button history-clear" onClick={clear}><Trash2 size={15}/>清空记录</button></section> : <section className="empty history-empty"><History size={34}/><h3>还没有转换记录</h3><p>完成转换后，文件会显示在这里</p></section>}</main>;
}

function SettingsPanel({ settings, setSettings, save, saved }) {
  const set = (key, value) => setSettings((old) => ({ ...old, [key]: value }));
  return <main className="settings-page">
    <div className="page-heading"><h1>设置</h1><p>调整输出格式、保存位置和文件命名方式</p></div>
    <section className="settings-section"><h3>输出</h3>
      <label className="field"><span>保存位置</span><div className="path-field"><input value={settings.outputDirectory} onChange={(e) => set('outputDirectory', e.target.value)}/><button title="选择文件夹" onClick={async () => { const value = await api.chooseFolder(settings.outputDirectory); if (value) set('outputDirectory', value); }}><FolderOpen size={18}/></button></div></label>
      {supportsTranscode ? <div className="field"><span>音频格式</span><div className="format-options">
        {[['auto','自动','跟随源文件'],['mp3','MP3','兼容性最好'],['flac','FLAC','无损音频']].map(([value,title,sub]) => <button key={value} className={settings.format === value ? 'selected' : ''} onClick={() => set('format', value)}><i>{settings.format === value && <Check size={13}/>}</i><strong>{title}</strong><small>{sub}</small></button>)}
      </div></div> : <div className="field"><span>音频格式<small>本版本不做格式转码，输出始终跟随源文件（MP3 出 MP3、无损保持无损）</small></span><div className="format-note">需要转成指定格式（MP3 / FLAC）请使用 Electron 便携版</div></div>}
      {supportsTranscode && settings.format === 'mp3' && <label className="field inline"><span>MP3 音质</span><select value={settings.mp3Bitrate} onChange={(e) => set('mp3Bitrate', e.target.value)}><option value="320k">320 kbps</option><option value="256k">256 kbps</option><option value="192k">192 kbps</option><option value="128k">128 kbps</option></select></label>}
    </section>
    <section className="settings-section"><h3>文件</h3>
      <label className="field inline"><span>文件名格式<small>支持 {'{title}'}、{'{artist}'}、{'{album}'}、{'{filename}'}</small></span><input value={settings.naming} onChange={(e) => set('naming', e.target.value)}/></label>
      <label className="field inline"><span>文件已存在时</span><select value={settings.conflict} onChange={(e) => set('conflict', e.target.value)}><option value="rename">自动添加序号</option><option value="overwrite">覆盖已有文件</option><option value="skip">跳过</option></select></label>
      <Toggle label="启动时自动查找" checked={settings.scanOnLaunch} onChange={(v) => set('scanOnLaunch', v)}/>
      <Toggle label="完成后打开输出文件夹" checked={settings.revealAfterComplete} onChange={(v) => set('revealAfterComplete', v)}/>
      <Toggle label="按歌手和专辑自动整理" checked={settings.organize} onChange={(v) => set('organize', v)}/>
    </section>
    {settings.extraFolders?.length ? <section className="settings-section"><h3>自动查找的额外目录</h3><p className="section-note">手动选择过的文件夹也会参与「自动查找」</p><div className="path-list">{settings.extraFolders.map((dir) => <div className="path-chip" key={dir}><span>{dir}</span><button className="icon-button" title="不再查找这个目录" onClick={() => set('extraFolders', settings.extraFolders.filter((item) => item !== dir))}><X size={15}/></button></div>)}</div></section> : null}
    <section className="settings-section"><h3>外观</h3><div className="theme-options"><button className={settings.theme === 'system' ? 'selected' : ''} onClick={() => set('theme', 'system')}><Sun size={16}/>跟随系统</button><button className={settings.theme === 'light' ? 'selected' : ''} onClick={() => set('theme', 'light')}><Sun size={16}/>浅色</button><button className={settings.theme === 'dark' ? 'selected' : ''} onClick={() => set('theme', 'dark')}><Moon size={16}/>深色</button></div></section>
    <section className="settings-section"><h3>关于</h3><div className="about-grid"><div><strong>NCM Studio</strong><small>版本 1.0.0</small></div><div><strong>版本类型</strong><small>{supportsTranscode ? 'Electron 便携版 · 完整功能' : 'Rust 桌面版 · 轻量'}</small></div><div><strong>制作</strong><small>3mber</small></div><div><strong>运行方式</strong><small>完全本地处理，不联网</small></div></div><p className="about-note">个人学习与技术研究项目。代码使用 MIT 许可{supportsTranscode ? '，随包内含 FFmpeg（GPL-3.0-or-later）' : '，本版本不含 FFmpeg，分发包里只有 MIT / Apache-2.0 / ISC 组件'}。</p><p className="about-note about-warn">请仅转换你本人已合法获得的音频文件，勿传播或商用；本程序与网易云音乐、网易公司无关联。</p><button className="secondary about-button" onClick={() => api.openLicenses()}><FileText size={16}/>查看开源许可</button></section>
    <button className="primary save" onClick={save}><Check size={17}/>{saved ? '已保存' : '保存设置'}</button><div className="maker-mark">3mber</div>
  </main>;
}

function Toggle({ label, checked, onChange }) { return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}/><i/></label>; }

function App() {
  useEffect(() => {
    // 启动自检：回报宿主类型、是否具备转码能力、以及界面上渲染出的版本标记
    const probe = [
      `shell=${document.documentElement.dataset.shell}`,
      `transcode=${supportsTranscode}`,
      `tag=${document.querySelector('.brand-tag')?.textContent || '(无)'}`
    ].join(' ');
    api.notifyUiReady?.(probe);
  }, []);
  const [view, setView] = useState('convert');
  const [files, setFiles] = useState([]);
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [scanning, setScanning] = useState(false);
  const [scanText, setScanText] = useState('');
  const [scanEmpty, setScanEmpty] = useState(false);
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [history, setHistory] = useState(loadHistory);
  const [highlightBatch, setHighlightBatch] = useState(() => localStorage.getItem('ncm-history-latest') && localStorage.getItem('ncm-history-seen') !== localStorage.getItem('ncm-history-latest') ? localStorage.getItem('ncm-history-latest') : null);
  const [historyUnread, setHistoryUnread] = useState(() => Boolean(localStorage.getItem('ncm-history-latest') && localStorage.getItem('ncm-history-seen') !== localStorage.getItem('ncm-history-latest')));

  const addPaths = async (paths) => {
    if (!paths?.length) return;
    try {
      const details = await api.fileDetails(paths);
      setFiles((current) => {
        const known = new Set(current.map((f) => f.path.toLowerCase()));
        return [...current, ...details.filter((f) => !known.has(f.path.toLowerCase())).map((f) => ({ ...f, phase: 'waiting', percent: 0, message: '等待转换' }))];
      });
    } catch (error) { setScanText(error.message); }
  };
  const scan = async (folder) => {
    setScanning(true); setScanEmpty(false); setScanText(folder ? '正在查找该文件夹…' : '正在检查网易云音乐常用的下载位置…');
    try {
      const result = await api.scan(folder);
      const found = result?.files || [];
      const places = result?.roots || 0;
      await addPaths(found.map((f) => f.path));
      setScanText(found.length ? `检查了 ${places} 个位置，找到 ${found.length} 个 NCM 文件` : `检查了 ${places} 个常用位置，没有找到 NCM 文件`);
      setScanEmpty(!found.length);
      if (folder) { const next = await api.saveSettings({ ...settings, extraFolders: [...new Set([...(settings.extraFolders || []), folder])] }); setSettings(next); }
    }
    catch (error) { setScanText(`查找失败：${error.message}`); }
    finally { setScanning(false); }
  };
  useEffect(() => { api.getSettings().then((value) => { const next = { ...EMPTY_SETTINGS, ...value }; setSettings(next); if (next.scanOnLaunch) scan(); }); }, []);
  useEffect(() => api.onScanProgress(({ count }) => setScanText(`已找到 ${count} 个文件，继续查找中…`)), []);
  useEffect(() => api.onConvertProgress((update) => setFiles((current) => current.map((f) => f.id === update.id ? { ...f, ...update } : f))), []);
  const completed = useMemo(() => files.filter((f) => f.phase === 'done').length, [files]);
  const overallProgress = useMemo(() => files.length ? Math.round(files.reduce((sum, file) => sum + (file.percent || 0), 0) / files.length) : 0, [files]);
  const convert = async () => {
    if (!files.length || working) return;
    setWorking(true); setFiles((old) => old.map((f) => ({ ...f, phase: 'waiting', percent: 0, message: '等待转换' })));
    try { const result = await api.convert(files, settings); const stamp = Date.now(); const completedNow = result.results?.filter((item) => item.status === 'done').map((item) => { const source = files.find((f) => f.id === item.id); return { id: `${item.id}-${stamp}`, batch: String(stamp), at: stamp, name: source?.metadata?.title || source?.name || '音频文件', format: (item.format || settings.format).toUpperCase(), time: new Date().toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }; }) || []; if (completedNow.length) setHistory((current) => { const next = [...completedNow, ...current].slice(0, 60); localStorage.setItem('ncm-history', JSON.stringify(next)); localStorage.setItem('ncm-history-latest', String(stamp)); setHighlightBatch(String(stamp)); setHistoryUnread(true); return next; }); } catch (error) { setScanText(`转换任务失败：${error.message}`); }
    finally { setWorking(false); }
  };
  const save = async () => { const next = await api.saveSettings(settings); setSettings(next); setSaved(true); setTimeout(() => setSaved(false), 1600); };
  useEffect(() => { const resolvedTheme = settings.theme === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme; document.documentElement.dataset.theme = resolvedTheme; api.setTheme(resolvedTheme); }, [settings.theme]);
  const markHighlightSeen = () => { if (highlightBatch) { localStorage.setItem('ncm-history-seen', highlightBatch); setHighlightBatch(null); } };
  const navigate = (nextView) => { if (nextView === 'history' && highlightBatch) { localStorage.setItem('ncm-history-seen', highlightBatch); setHistoryUnread(false); } setView(nextView); };
  const prevView = useRef(view);
  useEffect(() => { if (prevView.current === 'history' && view !== 'history') markHighlightSeen(); prevView.current = view; }, [view, highlightBatch]);
  return <><div className="window-bar"><strong>NCM Studio</strong><span>本地音频工具</span><em>v1.0.0</em></div><div className="app-shell"><Sidebar view={view} setView={setView} onNavigate={navigate} count={files.length} historyCount={historyUnread ? 1 : 0}/>
    {view === 'settings' ? <SettingsPanel settings={settings} setSettings={setSettings} save={save} saved={saved}/> : view === 'history' ? <HistoryPanel history={history} highlightBatch={highlightBatch} clear={() => { localStorage.removeItem('ncm-history'); setHistory([]); }}/> : <main className="content">
      <div className="page-heading"><div><h1>音频转换</h1><p>将网易云音乐 NCM 文件转换为通用音频格式</p></div><button className="output-link" title="打开输出文件夹" onClick={() => api.openFolder(settings.outputDirectory)}><FolderOpen size={18}/><span>{settings.outputDirectory || '输出文件夹'}</span></button></div>
      <DropZone onPaths={addPaths} scanning={scanning} onScan={scan}/>
      {scanText && <div className="notice"><Search size={14}/><span>{scanText}</span>{scanEmpty && !scanning && <button className="text-button" onClick={async () => { const folder = await api.chooseFolder(''); if (folder) scan(folder); }}><FolderOpen size={14}/>手动选择文件夹查找</button>}</div>}
      <Queue files={files} working={working} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} clearCompleted={() => setFiles((f) => f.filter((x) => x.phase !== 'done'))} remove={(id) => setFiles((f) => f.filter((x) => x.id !== id))} clear={() => { setFiles([]); setScanText(''); }}/>
      <p className="compliance-note">本项目仅供个人学习与技术研究使用，请仅转换你本人已合法获得的音频文件，勿用于传播或商业用途。</p>
      <footer className="actionbar"><div className="batch-status"><div><strong>{working ? `正在转换 · ${overallProgress}%` : completed ? `已完成 ${completed} 个文件` : '准备就绪'}</strong><span>{settings.format === 'auto' ? '输出格式跟随源文件' : `输出为 ${settings.format.toUpperCase()}`} · 原文件不会被修改</span></div>{working && <div className="batch-progress"><i style={{width: `${overallProgress}%`}}/></div>}</div>
        {working ? <button className="cancel" onClick={() => api.cancel()}><X size={17}/>停止任务</button> : <button className="primary convert" disabled={!files.length} onClick={convert}><Music2 size={18}/>开始转换</button>}
      </footer>
    </main>}
  </div></>;
}

createRoot(document.getElementById('root')).render(<App/>);
