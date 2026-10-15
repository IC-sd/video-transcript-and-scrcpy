# scrcpy 无线投屏

独立的无线投屏启动器，支持亮熄屏恢复和低延迟档位。项目目录可以放在任意位置。

## 初始化

Windows 64 位 PowerShell，在项目目录运行：

```powershell
& .\setup.ps1
```

脚本下载固定版本 scrcpy 5.0.1 与 Python 3.13.14 嵌入运行环境，验证官方发布摘要，然后放到 `tools/scrcpy` 与 `runtime/python`。无需改动系统 Python。该控制中继绑定 scrcpy 5.0.1 协议，不要仅替换引擎升级版本。

已有完整便携目录也可复用：

```powershell
& .\setup.ps1 -LocalSource 'D:\Tools\scrcpy'
& .\setup.ps1 -VerifyOnly
```

本地复用只复制 `tools/scrcpy` 和 `runtime/python`，不导入设备记录、日志或备份。

## 使用

双击 `启动投屏.bat`，或运行：

```powershell
& '.\启动投屏.bat'          # 默认熄屏投屏
& '.\启动投屏.bat' normal   # 手机亮屏投屏
& '.\启动投屏.bat' pair     # 首次或重新配对
& '.\启动投屏.bat' forget   # 清除记录并重新发现
& '.\启动投屏.bat' --check  # 检查 ADB，不启动投屏
& '.\启动投屏.bat' --diagnose  # 测量 ADB 往返，不启动投屏
```

手机和电脑需处于可互访的网络，手机开启无线调试。关闭投屏窗口结束，Ctrl+C 停止等待。保留手机原有锁屏和解锁方式。

## 低延迟设置

默认启动使用 `fast`。码率从旧版 8M 降到 4M，最长边从 1080 降到 960，以减少编码和 Wi-Fi 负担。硬件解码继续自动选择，失败时由 scrcpy 回退软件；视频不添加播放缓冲。

| 档位 | 最长边 | 码率上限 | 最高帧率 | 用途 |
| --- | --- | --- | --- | --- |
| `fast`（默认） | 960 | 4M | 60 | 操作响应优先 |
| `balanced` | 1080 | 8M | 60 | 网络较好、希望文字更清晰 |
| `weak-wifi` | 720 | 2M | 30 | 弱网或丢包明显时减少传输负担 |

```powershell
& '.\启动投屏.bat' --profile weak-wifi
& '.\启动投屏.bat' normal --profile balanced
& '.\启动投屏.bat' --max-size 800 --bit-rate 3M --max-fps 60
```

也可双击 `弱网投屏.bat`、`清晰投屏.bat` 或 `延迟诊断.bat`。弱网档位会降低画面清晰度和最高帧率，具体延迟改善取决于手机和网络。

`--diagnose` 记录 8 次 ADB 命令往返的中位数、P95 和失败次数，结果写入本机 `data/latency-diagnostics.json`。该数值包含命令启动开销，**不代表画面或触控的端到端延迟**。需要查看帧率日志时加 `--stats`；scrcpy 在静态画面下降低帧率是正常行为。

更多实现说明、验证边界和上游依据见 [延迟优化说明](docs/latency.md)。

## 目录

- `app/`：启动器与 scrcpy 控制消息中继。
- `tests/`：模拟设备回归测试。
- `docs/`：导入前的验证记录、依赖文件摘要与第三方许可。历史验证不是本次连接手机的证明。
- `data/`：本机生成的设备缓存和日志，不进入版本控制。
- `tools/scrcpy/`、`runtime/python/`：初始化生成的运行依赖，不进入版本控制。

## 测试

使用 Python 3.10 或更新版本：

```powershell
python -X utf8 -B tests/test_mirror.py
```

测试使用模拟设备，不进行真实配对或投屏；实体手机行为仍需实际环境验证。
