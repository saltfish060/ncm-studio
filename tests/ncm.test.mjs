import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { MAGIC, makeOutputName, parseNcm } = require('../electron/ncm.cjs');

describe('NCM signature', () => {
  it('uses the standard CTENFDAM file header', () => {
    expect(MAGIC.toString('ascii')).toBe('CTENFDAM');
  });

  it('rejects unrelated data', () => {
    expect(() => parseNcm(Buffer.alloc(64))).toThrow('文件头无效或格式不受支持');
  });
});

describe('makeOutputName', () => {
  it('applies metadata placeholders', () => {
    expect(makeOutputName('C:\\Music\\source.ncm', { title: 'Song', artist: 'Artist', album: 'Album' }, '{artist} - {title}')).toBe('Artist - Song');
  });

  it('falls back to source file name and sanitizes reserved characters', () => {
    expect(makeOutputName('C:\\Music\\source.ncm', { title: 'A/B:C', artist: '' }, '{title}')).toBe('A_B_C');
    expect(makeOutputName('C:\\Music\\source.ncm', {}, '{title}')).toBe('source');
  });
});
