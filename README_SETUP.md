# 健康鼠标（KeyStatsLauncher）后端与站点

## 目录结构

```
健康鼠标/
├── supabase/
│   └── schema.sql          # 后端完整 Schema（表 + RLS + SECURITY DEFINER 函数）
├── web/
│   ├── index.html          # 手部健康主题网站（登录/绑定/可视化）
│   ├── style.css
│   ├── app.js              # Supabase 交互 + 图表渲染
│   └── config.js           # Supabase 项目 URL 与 Publishable Key
├── config.go / main.go / uploader.go /
│   supabase.go / bind.go   # 启动器源码（Go 标准库，无第三方依赖、无需 C 编译器）
├── config.json             # 启动器配置模板
└── dist/                   # build.ps1 构建输出：KeyStatsLauncher.exe / -console.exe + config.json
```

## 部署步骤（先跑后端）

1. 在 [Supabase](https://supabase.com) 新建一个项目。
2. 打开 SQL Editor，将 `supabase/schema.sql` 整体粘贴执行。
3. 在 Project Settings → Data API 中：
   - 复制 **Project URL** → 填入 `web/config.js` 的 `url`
   - 复制 **Publishable Key**（新样式 Publishable Key）→ 填入 `web/config.js` 的 `publishableKey`
   - 同样填入启动器 `config.json`（连同 url 一起）的 `supabaseUrl` / `publishableKey`
4. 部署 `web/` 目录到任意静态托管（Netlify/Vercel/GitHub Pages 或本地 `python -m http.server`）。
5. 运行 `.\build.ps1` 构建启动器；把 `dist\config.json` 的 `supabaseUrl`/`publishableKey` 配好后再启动。

## 安全模型（重要）

- 三张表都启用 **RLS**，且对 `anon`(PublishableKey) / `authenticated` **不开放任何直接 DML**，并 `revoke` 掉其表权限。
- 所有功能经 **SECURITY DEFINER 函数** 暴露最小操作：
  - `register_device` 注册设备（验证码 + 设备密钥），返回设备 uuid
  - `refresh_bind_code` 已注册未绑定设备更换验证码（避免重复注册产生多余设备行）
  - `bind_device` 用验证码绑定设备到用户（一绑多），绑定时校验验证码有效期
  - `upload_snapshot` 上传健康快照（校验设备密钥 + 已绑定）
  - `get_device_status` 查询设备是否已绑定
  - `get_user_devices` / `get_health_snapshots` 网页端数据源
- **占位说明**：账号体系未接入，`user_id` 为用户输入的 id（微信 openid 占位）。正式接入微信小程序后，应把 `get_health_snapshots` / `get_user_devices` 等函数中的 `p_user_id` 改为从 `auth.uid()` 读取，建立 openid 映射，防止伪造他人数据。
- 密钥 `device_secret` 由启动器随机生成并仅本地保存（`config.json` 的 `deviceSecret`）；服务端仅校验匹配，无法反推。

## 绑定流程

`config.json` 中 `isBound=false` 即未绑定，每次启动器启动时进入绑定流程：

| 角色 | 动作 |
|------|------|
| 启动器（未绑定） | 生成 6 位验证码 → `register_device`/`refresh_bind_code` 保存 uuid/secret → 启动本地 127.0.0.1 随机端口 HTTP 服务 → 用默认浏览器打开绑定页 → 轮询 `get_device_status` |
| 网页 | 输入 id 登录 → 「绑定设备」页输入绑定页上的验证码 → `bind_device(验证码, id)` |
| 启动器 | 轮询到已绑定 → 写回 `config.json` 的 `isBound=true` → 绑定页显示成功 → 3 秒后关闭本地服务，进入后台常驻 |

## 上传

- 已绑定设备每 5 分钟读取 `%LOCALAPPDATA%\KeyStats\daily_stats.json`，剔除 `appStats` 后，
  调用 `upload_snapshot(device_uuid, device_secret, ...)` 追加一条时间序列快照到 `health_snapshots`。
- 未绑定（`isBound=false`）不上传；`config.json` 每周期重新读取，绑定时即时生效。