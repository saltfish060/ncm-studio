import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { collectNcmFiles, collectRoots, pruneNestedRoots, uniqueRoots } = require('../electron/scan.cjs');

describe('scan helpers', () => {
  it('去除重复路径', () => {
    expect(uniqueRoots(['C:\\Music', 'c:\\music', 'C:\\Music\\', 'D:\\Music'])).toEqual(['C:\\Music', 'D:\\Music']);
  });

  it('跳过被上层目录覆盖的路径', () => {
    expect(pruneNestedRoots(['F:\\CloudMusic\\VipSongsDownload', 'F:\\CloudMusic'])).toEqual(['F:\\CloudMusic']);
  });

  it('可以找到嵌套在下载目录里的 ncm 文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-scan-'));
    const nested = path.join(root, 'CloudMusic', 'VipSongsDownload');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'demo.ncm'), 'x');
    fs.writeFileSync(path.join(nested, 'readme.txt'), 'x');
    const files = await collectNcmFiles([root]);
    expect(files.map((file) => file.name)).toEqual(['demo.ncm']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('指定文件夹时只扫描该文件夹', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-scan-'));
    fs.writeFileSync(path.join(root, 'one.ncm'), 'x');
    const { roots } = await collectRoots({ customFolder: root, drives: [] });
    expect(roots).toEqual([root]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('跳过输出目录里已经存在的文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-scan-'));
    const output = path.join(root, 'NCM Studio');
    const source = path.join(root, 'CloudMusic', 'VipSongsDownload');
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(output, 'old.ncm'), 'x');
    fs.writeFileSync(path.join(source, 'new.ncm'), 'x');
    const files = await collectNcmFiles([root], { exclude: [output] });
    expect(files.map((file) => file.name)).toEqual(['new.ncm']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
