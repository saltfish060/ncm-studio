/* electron-builder 的 afterPack 钩子：给打包出来的应用 exe 写入图标与版本信息。

   electron-builder 自带的 rcedit 依赖 winCodeSign 工具包，而该工具包解压时需要创建
   符号链接（Windows 上需要管理员权限或开发者模式），普通账户会失败，因此这里改用独立
   依赖 rcedit 在打包阶段补写。
   NSIS 便携包的外层 exe 由 makensis 在编译时写入图标，不能再被 rcedit 修改
   （改动 PE 资源会破坏 NSIS 的数据结构），所以这里只处理应用自身的 exe。 */
const fs = require('node:fs');
const path = require('node:path');
const rcedit = require('rcedit');

module.exports = async function afterPack(context) {
  const icon = path.join(__dirname, '..', 'build', 'icon.ico');
  const { version, productFilename } = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  if (!fs.existsSync(exePath) || !fs.existsSync(icon)) return;
  await rcedit(exePath, {
    icon,
    'file-version': `${version}.0`,
    'product-version': version,
    'version-string': {
      ProductName: 'NCM Studio',
      FileDescription: 'NCM Studio 本地音频转换工具',
      CompanyName: '3mber',
      LegalCopyright: 'Copyright (c) 2026 3mber · MIT License',
      OriginalFilename: `${productFilename}.exe`,
      InternalName: 'NCM Studio'
    }
  });
  console.log(`  • 已写入图标与版本信息  ${path.basename(exePath)}`);
};
