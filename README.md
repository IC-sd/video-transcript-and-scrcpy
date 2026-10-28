# 学习资料与效率工具箱

三个独立目录放在同一个仓库，分别保存视频文稿提取器、无线投屏工具和 ITTO 学习表格，各自提供使用说明。

| 项目 | 用途 | 入口 |
| --- | --- | --- |
| [视频文稿提取器](projects/video-transcript-extractor/) | B站 / YouTube 字幕提取、精简文稿和 AI 总结 | 加载 `projects/video-transcript-extractor/extension` |
| [scrcpy 无线投屏](projects/scrcpy-mirror/) | Android 无线配对、投屏、亮熄屏切换和断线恢复 | 初始化依赖后运行 `projects/scrcpy-mirror/启动投屏.bat` |
| [中项49过程 ITTO 完整表格](projects/itto-49-processes/) | 系统集成项目管理工程师 ITTO 学习资料 | 下载后用浏览器打开 `projects/itto-49-processes/中项49过程ITTO完整表格.html` |

## 视频文稿提取器 v1.2.0

本地清理语气词、口头禅、重复对话和重复提问，同时保留原始转录供核对；支持分P、时间戳、Markdown 保存及可选 AI 总结。

安装：打开 Chrome / Edge 的扩展管理页，启用开发人员模式，选择「加载解压缩的扩展」，加载上表的 `extension` 文件夹。目录已从仓库根目录迁入 `projects/`，已有用户需更新加载路径，或将新版文件更新到原加载目录后重新加载。

详见 [文稿项目说明](projects/video-transcript-extractor/README.md) 和 [精简规则](projects/video-transcript-extractor/docs/cleanup.md)。

## scrcpy 无线投屏

日常只有一个启动入口，统一使用 1600 / 6Mbps / 最高 60fps，自动硬件解码和零额外视频缓冲。优先复用原手机在线通道，端口改变或掉线后持续自动恢复，避免重复启动。设备配对信息和日志仅留在本机。

```powershell
# 首次使用：下载并校验固定版本依赖
& .\projects\scrcpy-mirror\setup.ps1
# 启动；也可双击该文件
& .\projects\scrcpy-mirror\启动投屏.bat
```

已有本地便携目录时，可以不下载：

```powershell
& .\projects\scrcpy-mirror\setup.ps1 -LocalSource 'D:\Tools\scrcpy'
```

源码仓库不存放可重新下载的 Python / scrcpy 二进制，也不存放设备缓存、运行日志、ADB 私钥和历史备份。初始化脚本仅从锁文件中的官方 HTTPS 地址获取依赖并验证 SHA-256。

详见 [投屏项目说明](projects/scrcpy-mirror/README.md)。

## 中项49过程 ITTO 完整表格

独立的 HTML 学习页面，样式与脚本均内嵌，可离线打开，无需安装依赖。原文件内容与署名保留，浏览器本地记录不会自动跨设备同步。

详见 [ITTO 使用说明](projects/itto-49-processes/README.md)。

## 检查

```powershell
npm --prefix projects/video-transcript-extractor run check
npm --prefix projects/video-transcript-extractor test
python -X utf8 -B projects/scrcpy-mirror/tests/test_mirror.py
```

GitHub Actions 分别检查两个项目。浏览器扩展的浏览器集成测试另需 Playwright 和兼容浏览器；投屏的自动测试使用模拟设备，不会连接手机。

## 许可

自有代码沿用仓库 [MIT 许可](LICENSE)。第三方运行依赖使用各自的上游许可，见 [第三方说明](projects/scrcpy-mirror/THIRD_PARTY.md)。
