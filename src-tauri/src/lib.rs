mod ncm;
mod settings;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

pub struct AppState {
  cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDetail {
  id: String,
  path: String,
  name: String,
  size: u64,
  modified: u64,
  format: String,
  metadata: ncm::Metadata,
  cover_data_url: Option<String>,
}

#[derive(Serialize)]
pub struct ScanResult {
  files: Vec<FileDetail>,
  roots: usize,
}

#[derive(Deserialize)]
pub struct ConvertFile {
  id: String,
  path: String,
  size: u64,
  modified: u64,
}

#[derive(Serialize)]
pub struct ConvertItem {
  id: String,
  status: String,
  output_path: Option<String>,
  format: Option<String>,
  error: Option<String>,
}

#[derive(Serialize)]
pub struct ConvertResult {
  results: Vec<ConvertItem>,
  cancelled: bool,
}

fn config_dir(app: &AppHandle) -> PathBuf {
  app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn modified_millis(meta: &std::fs::Metadata) -> u64 {
  meta
    .modified()
    .ok()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

fn describe(path: &Path) -> Option<FileDetail> {
  let meta = std::fs::metadata(path).ok()?;
  let mut format = String::new();
  let mut metadata = ncm::Metadata::default();
  let mut cover_data_url = None;
  if let Ok(bytes) = std::fs::read(path) {
    if let Ok(decoded) = ncm::parse(&bytes) {
      format = decoded.format.clone();
      metadata = decoded.metadata.clone();
      if let Some(cover) = decoded.cover.filter(|data| data.len() < 2_000_000) {
        let mime = if cover.starts_with(&[0x89, 0x50, 0x4e, 0x47]) { "image/png" } else { "image/jpeg" };
        cover_data_url = Some(format!("data:{};base64,{}", mime, base64_encode(&cover)));
      }
    }
  }
  Some(FileDetail {
    id: format!("{}:{}", path.to_string_lossy(), modified_millis(&meta)),
    path: path.to_string_lossy().to_string(),
    name: path.file_name()?.to_string_lossy().to_string(),
    size: meta.len(),
    modified: modified_millis(&meta),
    format,
    metadata,
    cover_data_url,
  })
}

fn base64_encode(data: &[u8]) -> String {
  const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut output = String::with_capacity((data.len() + 2) / 3 * 4);
  for chunk in data.chunks(3) {
    let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
    let triple = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
    output.push(TABLE[(triple >> 18) as usize & 0x3f] as char);
    output.push(TABLE[(triple >> 12) as usize & 0x3f] as char);
    output.push(if chunk.len() > 1 { TABLE[(triple >> 6) as usize & 0x3f] as char } else { '=' });
    output.push(if chunk.len() > 2 { TABLE[triple as usize & 0x3f] as char } else { '=' });
  }
  output
}

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings {
  settings::load(&config_dir(&app))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<settings::Settings, String> {
  settings::save(&config_dir(&app), &settings)
}

#[tauri::command]
fn file_details(paths: Vec<String>) -> Vec<FileDetail> {
  let mut details = Vec::new();
  for path in paths {
    if !path.to_lowercase().ends_with(".ncm") {
      continue;
    }
    if let Some(detail) = describe(Path::new(&path)) {
      details.push(detail);
    }
  }
  details
}

fn collect_files(app: &AppHandle, root: &Path, found: &mut Vec<FileDetail>, limit: usize) {
  if found.len() >= limit {
    return;
  }
  let Ok(entries) = std::fs::read_dir(root) else { return };
  for entry in entries.flatten() {
    if found.len() >= limit {
      return;
    }
    let path = entry.path();
    let Ok(file_type) = entry.file_type() else { continue };
    if file_type.is_dir() {
      let name = entry.file_name().to_string_lossy().to_lowercase();
      if matches!(name.as_str(), "node_modules" | "$recycle.bin" | "system volume information" | "windows") {
        continue;
      }
      collect_files(app, &path, found, limit);
    } else if path.to_string_lossy().to_lowercase().ends_with(".ncm") {
      if let Some(detail) = describe(&path) {
        found.push(detail);
        let _ = app.emit(
          "scan:progress",
          serde_json::json!({ "count": found.len(), "current": path.to_string_lossy() }),
        );
      }
    }
  }
}

fn candidate_roots(extra: &[String]) -> Vec<PathBuf> {
  let mut roots: Vec<PathBuf> = Vec::new();
  if let Some(home) = settings::home_dir() {
    for part in [
      vec!["Music"],
      vec!["Downloads"],
      vec!["CloudMusic"],
      vec!["Music", "CloudMusic"],
      vec!["Music", "VipSongsDownload"],
      vec!["AppData", "Local", "Netease", "CloudMusic"],
    ] {
      let mut path = home.clone();
      for segment in part {
        path.push(segment);
      }
      roots.push(path);
    }
  }
  for letter in b'C'..=b'Z' {
    let root = PathBuf::from(format!("{}:\\", letter as char));
    if root.exists() {
      roots.push(root.join("CloudMusic"));
      roots.push(root.join("CloudMusic").join("VipSongsDownload"));
    }
  }
  for folder in extra {
    if !folder.trim().is_empty() {
      roots.push(PathBuf::from(folder));
    }
  }
  let mut unique: Vec<PathBuf> = Vec::new();
  for root in roots {
    if root.is_dir() && !unique.iter().any(|item| item == &root) {
      unique.push(root);
    }
  }
  unique
}

#[tauri::command]
fn scan(app: AppHandle, folder: Option<String>) -> ScanResult {
  let config = settings::load(&config_dir(&app));
  let roots = match folder.filter(|value| !value.trim().is_empty()) {
    Some(folder) => {
      let path = PathBuf::from(folder);
      if path.is_dir() { vec![path] } else { Vec::new() }
    }
    None => candidate_roots(&config.extra_folders),
  };
  let mut files = Vec::new();
  for root in &roots {
    collect_files(&app, root, &mut files, 5000);
  }
  ScanResult { files, roots: roots.len() }
}

#[tauri::command]
fn convert(app: AppHandle, files: Vec<ConvertFile>, settings: settings::Settings) -> ConvertResult {
  let cancel = app.state::<AppState>().cancel.clone();
  cancel.store(false, Ordering::SeqCst);
  let mut results = Vec::new();
  let output_root = PathBuf::from(&settings.output_directory);
  let total = files.len();
  if let Err(error) = std::fs::create_dir_all(&output_root) {
    return ConvertResult {
      results: files
        .iter()
        .map(|file| ConvertItem {
          id: file.id.clone(),
          status: "error".into(),
          output_path: None,
          format: None,
          error: Some(error.to_string()),
        })
        .collect(),
      cancelled: false,
    };
  }

  for (index, file) in files.iter().enumerate() {
    if cancel.load(Ordering::SeqCst) {
      results.push(ConvertItem {
        id: file.id.clone(),
        status: "skipped".into(),
        output_path: None,
        format: None,
        error: Some("任务已停止".into()),
      });
      continue;
    }
    let emit = |payload: serde_json::Value| {
      let _ = app.emit("convert:progress", payload);
    };
    emit(serde_json::json!({ "id": file.id, "index": index, "total": total, "phase": "decrypting", "percent": 8, "message": "正在读取并解密音频数据" }));

    let outcome = (|| -> Result<(String, String, String), String> {
      let bytes = std::fs::read(&file.path).map_err(|error| error.to_string())?;
      let decoded = ncm::parse(&bytes)?;
      let name = ncm::make_output_name(&file.path, &decoded.metadata, &settings.naming);
      let directory = if settings.organize {
        let artist = if decoded.metadata.artist.is_empty() { "未知歌手".to_string() } else { ncm::safe_name(&decoded.metadata.artist) };
        let album = if decoded.metadata.album.is_empty() { "未知专辑".to_string() } else { ncm::safe_name(&decoded.metadata.album) };
        output_root.join(artist).join(album)
      } else {
        output_root.clone()
      };
      std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
      let mut target = directory.join(format!("{}.{}", name, decoded.format));
      if target.exists() {
        match settings.conflict.as_str() {
          "skip" => return Ok(("skipped".into(), String::new(), decoded.format)),
          "overwrite" => {
            let _ = std::fs::remove_file(&target);
          }
          _ => {
            let mut counter = 1;
            while target.exists() && counter < 1000 {
              target = directory.join(format!("{} ({}).{}", name, counter, decoded.format));
              counter += 1;
            }
          }
        }
      }
      emit(serde_json::json!({ "id": file.id, "index": index, "total": total, "phase": "converting", "percent": 60, "message": "正在写入音频文件" }));
      std::fs::write(&target, &decoded.audio).map_err(|error| error.to_string())?;
      Ok(("done".into(), target.to_string_lossy().to_string(), decoded.format))
    })();

    match outcome {
      Ok((status, output, detected)) => {
        emit(serde_json::json!({ "id": file.id, "index": index, "total": total, "phase": status, "percent": 100, "message": if status == "skipped" { "目标文件已存在，已跳过".to_string() } else { format!("已保存到 {}", Path::new(&output).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()) }, "outputPath": output }));
        results.push(ConvertItem {
          id: file.id.clone(),
          status,
          output_path: if output.is_empty() { None } else { Some(output) },
          format: Some(detected),
          error: None,
        });
      }
      Err(error) => {
        emit(serde_json::json!({ "id": file.id, "index": index, "total": total, "phase": "error", "percent": 100, "message": error }));
        results.push(ConvertItem {
          id: file.id.clone(),
          status: "error".into(),
          output_path: None,
          format: None,
          error: Some(error),
        });
      }
    }
  }

  if settings.reveal_after_complete {
    open_path(&output_root);
  }
  ConvertResult { results, cancelled: cancel.load(Ordering::SeqCst) }
}

#[tauri::command]
fn cancel_convert(app: AppHandle) -> bool {
  app.state::<AppState>().cancel.store(true, Ordering::SeqCst);
  true
}

/* 前端渲染完成后回调一次，便于打包后自检界面是否真的起来了 */
#[tauri::command]
fn ui_ready(app: AppHandle, shell: Option<String>, probe: Option<String>) -> bool {
  let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
  let _ = std::fs::create_dir_all(&dir);
  let token = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or(0);
  let payload = format!(
    "shell={};probe={};at={}",
    shell.unwrap_or_else(|| "unknown".into()),
    probe.unwrap_or_default(),
    token
  );
  std::fs::write(dir.join("ui-ready.txt"), payload).is_ok()
}

fn open_path(path: &Path) {
  #[cfg(target_os = "windows")]
  {
    let _ = std::process::Command::new("explorer").arg(path).spawn();
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = std::process::Command::new("open").arg(path).spawn();
  }
}

#[tauri::command]
fn open_folder(folder: String) -> bool {
  let path = PathBuf::from(&folder);
  let _ = std::fs::create_dir_all(&path);
  open_path(&path);
  true
}

#[tauri::command]
fn reveal_file(path: String) -> bool {
  let target = PathBuf::from(&path);
  if target.exists() {
    open_path(target.parent().unwrap_or(&target));
  }
  true
}

#[tauri::command]
fn open_licenses() -> bool {
  let candidates = [
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("licenses"))),
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("THIRD-PARTY-NOTICES.md"))),
    Some(PathBuf::from("licenses")),
    Some(PathBuf::from("THIRD-PARTY-NOTICES.md")),
  ];
  for candidate in candidates.into_iter().flatten() {
    if candidate.exists() {
      open_path(&candidate);
      return true;
    }
  }
  false
}

fn smoke_test(path: &str) -> String {
  use sha2::{Digest, Sha256};
  let outcome = std::fs::read(path)
    .map_err(|error| error.to_string())
    .and_then(|bytes| ncm::parse(&bytes));
  match outcome {
    Ok(decoded) => {
      let mut hasher = Sha256::new();
      hasher.update(&decoded.audio);
      let digest = hex::encode(hasher.finalize());
      serde_json::json!({
        "ok": true,
        "format": decoded.format,
        "sha256": &digest[..16],
        "bytes": decoded.audio.len(),
        "coverBytes": decoded.cover.map(|data| data.len()).unwrap_or(0),
        "metadata": {
          "title": decoded.metadata.title,
          "artist": decoded.metadata.artist,
          "album": decoded.metadata.album,
          "bitrate": decoded.metadata.bitrate,
        },
        "outputName": ncm::make_output_name(path, &decoded.metadata, "{title}"),
      })
      .to_string()
    }
    Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
  }
}

/* 走一遍真实转换流程（解密 → 命名 → 写文件），供打包后自检 */
fn convert_smoke(path: &str, out_dir: &str) -> String {
  let outcome = std::fs::read(path)
    .map_err(|error| error.to_string())
    .and_then(|bytes| ncm::parse(&bytes));
  match outcome {
    Ok(decoded) => {
      let name = ncm::make_output_name(path, &decoded.metadata, "{title}");
      let directory = PathBuf::from(out_dir);
      if let Err(error) = std::fs::create_dir_all(&directory) {
        return serde_json::json!({ "ok": false, "error": error.to_string() }).to_string();
      }
      let target = directory.join(format!("{}.{}", name, decoded.format));
      match std::fs::write(&target, &decoded.audio) {
        Ok(_) => serde_json::json!({
          "ok": true,
          "output": target.to_string_lossy(),
          "fileName": target.file_name().map(|n| n.to_string_lossy().to_string()),
          "format": decoded.format,
          "writtenBytes": std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0),
          "sourceBytes": decoded.audio.len(),
        })
        .to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }).to_string(),
      }
    }
    Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 自检模式：app.exe --smoke <ncm 文件> <结果输出文件>
  let args: Vec<String> = std::env::args().collect();
  if args.len() >= 4 && args[1] == "--smoke" {
    let report = smoke_test(&args[2]);
    let _ = std::fs::write(&args[3], report);
    std::process::exit(0);
  }
  // 转换自检：app.exe --convert-smoke <ncm 文件> <输出目录> <结果文件>
  if args.len() >= 5 && args[1] == "--convert-smoke" {
    let report = convert_smoke(&args[2], &args[3]);
    let _ = std::fs::write(&args[4], report);
    std::process::exit(0);
  }

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(AppState { cancel: Arc::new(AtomicBool::new(false)) })
    .invoke_handler(tauri::generate_handler![
      get_settings,
      save_settings,
      file_details,
      scan,
      convert,
      cancel_convert,
      ui_ready,
      open_folder,
      reveal_file,
      open_licenses
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
