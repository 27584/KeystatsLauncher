# 健康鼠标（KeyStatsLauncher）

手部健康监测：在 KeyStats 键鼠数据统计的基础上，增加设备绑定、定时数据上传与网页可视化看板。

> 本项目在 [debugtheworldbot/keyStats](https://github.com/debugtheworldbot/keyStats) 项目基础上开发。

## 目录结构

```
健康鼠标/
├── main.go            # 启动器主程序：拉起 KeyStats、定时上传、未绑定则打开绑定页
├── config.go          # 运行参数 config.json + 绑定状态设备配置（LAN）
├── bind.go            # 本地绑定窗口（HTTP 服务 + 浏览器页面）
├── uploader.go        # 读取 KeyStats 当日数据并上传（剔除 appStats）
├── supabase.go        # Supabase RPC 客户端
├── sync_autostart.go  # 开机自启跟随 KeyStats
├── config.json        # 运行参数（程序目录）
├── supabase/schema.sql# 后端完整 Schema（表 + 安全策略 + 函数，可复现后端）
├── web/               # 网页看板（HTML/CSS/JS，基于 Supabase 后端）
├── dist/              # 构建输出目录
└── build.ps1          # 一键构建脚本
```

## 配置分离说明

- **运行参数**：程序目录下的 `config.json`，含 `keyStatsExe`、上传间隔、Supabase 地址/公钥等。
- **绑定状态**：`%LOCALAPPDATA%\KeyStatsUploader\config.json`，含 `uuid`、`is_bound`、`device_secret`，与程序目录相互独立，更新程序不会被覆盖。

## 编译说明

1. 将 KeyStats 可执行程序**整个目录重命名为 `App`**，放入 `dist` 目录，即最终结构为：
   ```
   dist/App/KeyStats.exe
   ```
   （`config.json` 中 `keyStatsExe` 默认指向 `App/KeyStats.exe`。）

2. 安装 Go 工具链：
   - **推荐：使用系统 Go。** 到 [go.dev/dl](https://go.dev/dl) 下载安装（建议 Go 1.21+），确保 `go` 在 PATH 中。构建脚本检测不到 `.toolchain\go` 时会自动回退到 PATH 上的 `go`。
   - **可选：项目内工具链。** 将 Go 安装目录重命名为 `go` 放到 `.toolchain` 下，即 `.toolchain\go\bin\go.exe` 存在即可（同 Windows 版 Go Windows ZIP 包的目录结构）。

   > `.toolchain` 下的 `go`、`cache`、`gopath` 均被 git 忽略，不会入库；换机器需重新放置工具链。

3. 运行构建脚本（在项目根目录、使用 PowerShell）：
   ```powershell
   ./build.ps1
   ```

   构建产物输出到 `dist/`：
   - `KeyStatsLauncher.exe`：正式版（无控制台窗口）
   - `KeyStatsLauncher-console.exe`：控制台调试版
   - `config.json`：首次运行时自动从项目根复制
   - 脚本会提示把 `KeyStats.exe` 放到 `dist/App/`（见步骤 1）


## 快速开始（绑定 + 上传）

1. 构建并配置好 `dist/App/KeyStats.exe` 与 `dist/config.json`（Supabase 地址/公钥）。
2. 首次运行 `KeyStatsLauncher.exe`，未绑定时自动打开绑定窗口，显示 6 位验证码（5 分钟有效，可重新发送）。
3. 在网页「绑定设备」页输入验证码，将设备与账号绑定。
4. 绑定成功后，启动器每 5 分钟自动上传一次当日键鼠数据（不含 appStats）。

## 后端部署

Supabase 端完整表结构、安全策略与函数见 [`supabase/schema.sql`](supabase/schema.sql)，可直接以此复现后端。详细部署步骤见 [`README_SETUP.md`](README_SETUP.md)。

## 网页看板

- `web/` 为静态站点（登录 → 看板）。支持按设备切换查看，并提供按键/点击速率曲线（基于当天多次上报的时间差与数值差计算）。
- 需在 `web/config.js` 配置 Supabase 项目地址与新版 Publishable Key。