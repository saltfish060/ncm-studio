# 第三方组件与许可声明

本程序（NCM Studio）自身的源代码使用 **MIT** 许可，完整文本见 [LICENSE](LICENSE)。
发布的分发包中还包含以下第三方组件，各自的许可与来源如下。

## FFmpeg（GPL-3.0-or-later）

| 项目 | 说明 |
| --- | --- |
| 组件 | FFmpeg（`ffmpeg.exe`） |
| 引入方式 | 经 `ffmpeg-static` 5.2.0 获取 |
| 调用方式 | 以**独立进程**调用（`child_process.spawn`），未链接进本程序，二进制与代码均未修改 |
| 二进制来源 | https://github.com/eugeneware/ffmpeg-static （由 https://www.gyan.dev/ffmpeg/builds/ 构建） |
| 上游源码 | https://github.com/FFmpeg/FFmpeg |
| 许可 | GNU General Public License v3.0 or later，完整文本见 `licenses/GPL-3.0.txt` |
| 实际版本 | `ffmpeg version 6.0-essentials_build`，构建参数可在命令行执行 `ffmpeg -version` 查看 |

依据 GPL 的条款，该二进制允许被再分发，但再分发时应当保留许可证文本、标明来源，并提供获取对应源代码的途径。
本程序随分发包提供了 `licenses/GPL-3.0.txt`、`licenses/ffmpeg-README.txt` 与本声明。
本程序自身代码与 FFmpeg 二进制之间是"聚合（aggregation）"关系，因此本程序自身代码仍按 MIT 许可发布。

## 其他依赖

| 组件 | 许可 | 项目地址 |
| --- | --- | --- |
| Electron | MIT | https://github.com/electron/electron |
| React / React DOM | MIT | https://github.com/facebook/react |
| lucide-react | ISC | https://github.com/lucide-icons/lucide |
| Vite | MIT | https://github.com/vitejs/vite |
| ffmpeg-static | GPL-3.0-or-later | https://github.com/eugeneware/ffmpeg-static |

以上组件均以未修改的原始形式使用。

## 免责声明

- 本项目为个人学习与技术研究项目，用于学习音频容器格式与本地文件处理。
- 本程序与网易云音乐、网易公司没有任何关联，也未获得其授权或认可。
- 本程序不提供在线音乐下载、会员绕过或破解功能，仅对**本机已存在**的 `.ncm` 文件做格式转换。
- 本程序完全在本机运行，不发起任何网络请求，不上传任何文件。
- 请仅转换你本人已合法获得的音频文件，供个人离线使用，勿用于传播或商业用途。
- 请在遵守当地法律与相关服务条款的前提下使用，并对自己的使用行为负责。
