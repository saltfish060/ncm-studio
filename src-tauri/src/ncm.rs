/* 网易云 NCM 解密：算法与前端/Electron 版保持一致 */
use aes::cipher::{BlockDecrypt, KeyInit, generic_array::GenericArray};
use aes::Aes128;
use serde::Serialize;

const CORE_KEY: [u8; 16] = [
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f, 0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57,
];
const META_KEY: [u8; 16] = [
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21, 0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28,
];
const MAGIC: &[u8; 8] = b"CTENFDAM";

#[derive(Default, Serialize, Clone)]
pub struct Metadata {
  pub title: String,
  pub artist: String,
  pub album: String,
  pub bitrate: u64,
}

pub struct Decoded {
  pub audio: Vec<u8>,
  pub format: String,
  pub cover: Option<Vec<u8>>,
  pub metadata: Metadata,
}

fn read_u32(buffer: &[u8], offset: usize) -> Result<u32, String> {
  if offset + 4 > buffer.len() {
    return Err("文件结构不完整".into());
  }
  Ok(u32::from_le_bytes([buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]]))
}

fn aes128_ecb_decrypt(data: &[u8], key: &[u8; 16]) -> Result<Vec<u8>, String> {
  if data.len() % 16 != 0 {
    return Err("密钥区长度异常".into());
  }
  let cipher = Aes128::new(GenericArray::from_slice(key));
  let mut output = data.to_vec();
  for chunk in output.chunks_mut(16) {
    cipher.decrypt_block(GenericArray::from_mut_slice(chunk));
  }
  // 去掉 PKCS#7 填充
  if let Some(&pad) = output.last() {
    let pad = pad as usize;
    if pad >= 1 && pad <= 16 && pad <= output.len() {
      let start = output.len() - pad;
      if output[start..].iter().all(|&b| b as usize == pad) {
        output.truncate(start);
      }
    }
  }
  Ok(output)
}

pub fn parse(buffer: &[u8]) -> Result<Decoded, String> {
  if buffer.len() < 32 {
    return Err("文件过小，不是有效的 NCM 文件".into());
  }
  if &buffer[0..8] != MAGIC {
    return Err("文件头无效或格式不受支持".into());
  }

  let mut offset = 10usize;
  let key_length = read_u32(buffer, offset)? as usize;
  offset += 4;
  if key_length == 0 || offset + key_length > buffer.len() {
    return Err("密钥区损坏".into());
  }
  let mut encrypted_key = buffer[offset..offset + key_length].to_vec();
  for byte in encrypted_key.iter_mut() {
    *byte ^= 0x64;
  }
  offset += key_length;

  let key_data = aes128_ecb_decrypt(&encrypted_key, &CORE_KEY)?;
  if key_data.len() <= 17 {
    return Err("无法读取音频密钥".into());
  }
  let key = &key_data[17..];

  let mut key_box: Vec<u8> = (0..=255u8).collect();
  let mut key_offset = 0usize;
  let mut last_byte = 0usize;
  for i in 0..256usize {
    let swap = key_box[i] as usize;
    key_offset = (swap + last_byte + key[i % key.len()] as usize) & 0xff;
    key_box[i] = key_box[key_offset];
    key_box[key_offset] = swap as u8;
    last_byte = key_offset;
  }

  let mut metadata = Metadata::default();
  let meta_length = read_u32(buffer, offset)? as usize;
  offset += 4;
  if meta_length > 0 && offset + meta_length <= buffer.len() {
    if let Ok(plain) = decode_metadata(&buffer[offset..offset + meta_length]) {
      metadata = plain;
    }
  }
  offset += meta_length;
  offset += 5; // CRC32 与图片版本号
  let cover_frame_length = read_u32(buffer, offset)? as usize;
  offset += 4;
  let image_length = read_u32(buffer, offset)? as usize;
  offset += 4;
  if image_length > cover_frame_length || offset + cover_frame_length > buffer.len() {
    return Err("封面数据区损坏".into());
  }
  let cover = if image_length > 0 {
    Some(buffer[offset..offset + image_length].to_vec())
  } else {
    None
  };
  offset += cover_frame_length;
  if offset >= buffer.len() {
    return Err("文件中没有音频数据".into());
  }

  let mut audio = buffer[offset..].to_vec();
  for i in 0..audio.len() {
    let j = (i + 1) & 0xff;
    let index = (key_box[j] as usize + key_box[(key_box[j] as usize + j) & 0xff] as usize) & 0xff;
    audio[i] ^= key_box[index];
  }

  Ok(Decoded {
    format: detect_format(&audio),
    audio,
    cover,
    metadata,
  })
}

fn detect_format(audio: &[u8]) -> String {
  if audio.len() > 4 && &audio[0..4] == b"fLaC" {
    return "flac".into();
  }
  if audio.len() > 3 && &audio[0..3] == b"ID3" {
    return "mp3".into();
  }
  if audio.len() > 1 && audio[0] == 0xff && (audio[1] & 0xe0) == 0xe0 {
    return "mp3".into();
  }
  "mp3".into()
}

fn decode_metadata(encrypted: &[u8]) -> Result<Metadata, String> {
  if encrypted.len() <= 22 {
    return Err("元数据区过短".into());
  }
  let mut data = encrypted.to_vec();
  for byte in data.iter_mut() {
    *byte ^= 0x63;
  }
  let encoded = std::str::from_utf8(&data[22..]).map_err(|_| "元数据编码异常")?;
  let decoded = base64_decode(encoded.trim())?;
  let plain = aes128_ecb_decrypt(&decoded, &META_KEY)?;
  let text = String::from_utf8_lossy(&plain);
  let json = text.strip_prefix("music:").unwrap_or(&text);
  let value: serde_json::Value = serde_json::from_str(json).map_err(|_| "元数据解析失败")?;

  let artist = match value.get("artist") {
    Some(serde_json::Value::Array(list)) => list
      .iter()
      .filter_map(|item| item.as_array().and_then(|inner| inner.first()).or(Some(item)))
      .filter_map(|item| item.as_str())
      .collect::<Vec<_>>()
      .join(", "),
    Some(serde_json::Value::String(name)) => name.clone(),
    _ => String::new(),
  };

  Ok(Metadata {
    title: value.get("musicName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    artist,
    album: value.get("album").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    bitrate: value.get("bitrate").and_then(|v| v.as_u64()).unwrap_or(0),
  })
}

/* NCM 里的元数据是标准 base64，这里手写一份以免引入额外依赖 */
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
  const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut lookup = [255u8; 256];
  for (index, &ch) in TABLE.iter().enumerate() {
    lookup[ch as usize] = index as u8;
  }
  let mut output = Vec::with_capacity(input.len() / 4 * 3);
  let mut buffer = 0u32;
  let mut bits = 0u32;
  for ch in input.bytes() {
    if ch == b'=' {
      break;
    }
    let value = lookup[ch as usize];
    if value == 255 {
      continue;
    }
    buffer = (buffer << 6) | value as u32;
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      output.push((buffer >> bits) as u8);
    }
  }
  Ok(output)
}

pub fn safe_name(value: &str) -> String {
  let cleaned: String = value
    .chars()
    .map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c })
    .collect();
  cleaned.trim_end_matches(|c| c == '.' || c == ' ').trim().to_string()
}

pub fn make_output_name(source: &str, metadata: &Metadata, template: &str) -> String {
  let stem = std::path::Path::new(source)
    .file_stem()
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_else(|| source.to_string());
  let title = if metadata.title.is_empty() { safe_name(&stem) } else { safe_name(&metadata.title) };
  let artist = if metadata.artist.is_empty() { "未知歌手".to_string() } else { safe_name(&metadata.artist) };
  let album = if metadata.album.is_empty() { "未知专辑".to_string() } else { safe_name(&metadata.album) };
  let file_name = safe_name(&stem);

  let mut name = String::new();
  let mut rest = template;
  while let Some(start) = rest.find('{') {
    name.push_str(&rest[..start]);
    let after = &rest[start + 1..];
    match after.find('}') {
      Some(end) => {
        let key = &after[..end];
        name.push_str(match key {
          "title" => &title,
          "artist" => &artist,
          "album" => &album,
          "filename" => &file_name,
          _ => "",
        });
        rest = &after[end + 1..];
      }
      None => {
        name.push_str(&rest[start..]);
        rest = "";
      }
    }
  }
  name.push_str(rest);

  let cleaned = safe_name(&name);
  if cleaned.is_empty() { file_name } else { cleaned }
}
