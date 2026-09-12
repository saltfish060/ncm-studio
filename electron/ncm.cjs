const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex');
const META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex');
// Standard NCM files begin with the two little-endian words "CTEN"/"FDAM".
// The bytes after this header are the format's reserved/version fields.
const MAGIC = Buffer.from('CTENFDAM', 'ascii');

function decryptAes(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function readUInt32(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error('文件结构不完整');
  return buffer.readUInt32LE(offset);
}

function safeName(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
}

function parseNcm(buffer) {
  if (buffer.length < 32) throw new Error('文件过小，不是有效的 NCM 文件');
  if (!buffer.subarray(0, 8).equals(MAGIC)) throw new Error('文件头无效或格式不受支持');

  let offset = 10;
  const keyLength = readUInt32(buffer, offset);
  offset += 4;
  if (keyLength <= 0 || offset + keyLength > buffer.length) throw new Error('密钥区损坏');
  const encryptedKey = Buffer.from(buffer.subarray(offset, offset + keyLength));
  for (let i = 0; i < encryptedKey.length; i += 1) encryptedKey[i] ^= 0x64;
  offset += keyLength;

  const keyData = decryptAes(encryptedKey, CORE_KEY);
  if (keyData.length <= 17) throw new Error('无法读取音频密钥');
  const key = keyData.subarray(17);
  const keyBox = Array.from({ length: 256 }, (_, i) => i);
  let keyOffset = 0;
  let lastByte = 0;
  for (let i = 0; i < 256; i += 1) {
    const swap = keyBox[i];
    keyOffset = (swap + lastByte + key[i % key.length]) & 0xff;
    keyBox[i] = keyBox[keyOffset];
    keyBox[keyOffset] = swap;
    lastByte = keyOffset;
  }

  let metadata = {};
  const metaLength = readUInt32(buffer, offset);
  offset += 4;
  if (metaLength > 0 && offset + metaLength <= buffer.length) {
    try {
      const encryptedMeta = Buffer.from(buffer.subarray(offset, offset + metaLength));
      for (let i = 0; i < encryptedMeta.length; i += 1) encryptedMeta[i] ^= 0x63;
      const base64 = encryptedMeta.subarray(22).toString('utf8');
      const plain = decryptAes(Buffer.from(base64, 'base64'), META_KEY).toString('utf8');
      metadata = JSON.parse(plain.replace(/^music:/, ''));
    } catch {
      metadata = {};
    }
  }
  offset += metaLength;
  offset += 5; // CRC32 and image version
  const coverFrameLength = readUInt32(buffer, offset);
  offset += 4;
  const imageLength = readUInt32(buffer, offset);
  offset += 4;
  if (imageLength > coverFrameLength || offset + coverFrameLength > buffer.length) throw new Error('封面数据区损坏');
  const imageData = imageLength > 0 ? Buffer.from(buffer.subarray(offset, offset + imageLength)) : null;
  offset += coverFrameLength;
  if (offset >= buffer.length) throw new Error('文件中没有音频数据');

  const audio = Buffer.from(buffer.subarray(offset));
  for (let i = 0; i < audio.length; i += 1) {
    const j = (i + 1) & 0xff;
    audio[i] ^= keyBox[(keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff];
  }

  let format = String(metadata.format || '').toLowerCase();
  if (audio.subarray(0, 4).toString() === 'fLaC') format = 'flac';
  else if (audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)) format = 'mp3';
  if (!['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg'].includes(format)) format = 'mp3';

  const artists = Array.isArray(metadata.artist) ? metadata.artist.map((a) => Array.isArray(a) ? a[0] : a).filter(Boolean) : [];
  return {
    audio,
    format,
    coverData: imageData,
    metadata: {
      title: metadata.musicName || '',
      artist: artists.join(', '),
      album: metadata.album || '',
      bitrate: metadata.bitrate || null
    }
  };
}

async function decodeFile(inputPath, tempPath) {
  const input = await fs.promises.readFile(inputPath);
  const decoded = parseNcm(input);
  const decodedPath = `${tempPath}.${decoded.format}`;
  await fs.promises.writeFile(decodedPath, decoded.audio);
  return { ...decoded, audio: undefined, coverData: undefined, decodedPath };
}

function makeOutputName(inputPath, metadata, template) {
  const source = path.basename(inputPath, path.extname(inputPath));
  const values = {
    title: safeName(metadata.title) || safeName(source),
    artist: safeName(metadata.artist) || '未知歌手',
    album: safeName(metadata.album) || '未知专辑',
    filename: safeName(source)
  };
  let name = template || '{title}';
  name = name.replace(/\{(title|artist|album|filename)\}/g, (_, key) => values[key]);
  return safeName(name) || values.filename || 'audio';
}

module.exports = { MAGIC, parseNcm, decodeFile, makeOutputName, safeName };
