use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
  pub output_directory: String,
  pub format: String,
  pub mp3_bitrate: String,
  pub conflict: String,
  pub naming: String,
  pub scan_on_launch: bool,
  pub reveal_after_complete: bool,
  pub organize: bool,
  pub extra_folders: Vec<String>,
  pub theme: String,
  #[serde(default)]
  pub format_migrated: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      output_directory: String::new(),
      format: "auto".into(),
      mp3_bitrate: "320k".into(),
      conflict: "rename".into(),
      naming: "{title}".into(),
      scan_on_launch: false,
      reveal_after_complete: false,
      organize: false,
      extra_folders: Vec::new(),
      theme: "system".into(),
      format_migrated: true,
    }
  }
}

pub fn default_output_directory() -> String {
  home_dir()
    .map(|home| home.join("Music").join("NCM Studio").to_string_lossy().to_string())
    .unwrap_or_else(|| "NCM Studio".into())
}

pub fn home_dir() -> Option<PathBuf> {
  std::env::var_os("USERPROFILE").map(PathBuf::from)
}

pub fn load(config_dir: &Path) -> Settings {
  let path = config_dir.join("settings.json");
  let mut settings = fs::read_to_string(&path)
    .ok()
    .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
    .unwrap_or_default();
  if settings.output_directory.trim().is_empty() {
    settings.output_directory = default_output_directory();
  }
  if !matches!(settings.format.as_str(), "auto" | "mp3" | "flac") {
    settings.format = "auto".into();
  }
  settings
}

pub fn save(config_dir: &Path, settings: &Settings) -> Result<Settings, String> {
  fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
  let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
  fs::write(config_dir.join("settings.json"), text).map_err(|error| error.to_string())?;
  Ok(settings.clone())
}
