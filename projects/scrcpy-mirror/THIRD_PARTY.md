# 第三方依赖

- [scrcpy 5.0.1](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1)：Genymobile 开源投屏引擎；原有 Apache 2.0 许可保存在 `docs/scrcpy-LICENSE.txt`。发行包中的 FFmpeg、SDL、libusb、ADB 等组件分别保留其上游许可。
- [Python 3.13.14](https://www.python.org/ftp/python/3.13.14/)：Python Software Foundation；许可保存在 `docs/python-LICENSE.txt`，解压运行环境也保留其自带许可。

源码仓库不提交第三方二进制。依赖 URL、版本和 SHA-256 固定在 `dependencies.lock.json`；`docs/imported-dependencies.json` 记录导入前本地便携依赖的文件摘要，供迁移核对。
