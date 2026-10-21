# 健康鼠标（KeyStatsLauncher）后端与站点

## 目录结构

```
健康鼠标/
├── supabase/
│   └── schema.sql          # 后端完整 Schema（表 + RLS + SECURITY DEFINER 函数）
├── web/
│   ├── index.html          # 手部健康主题网站（登录/绑定/可视化）
│   ├── style.css
│   ├── app.js              # Supabase 交互 + 图表渲染 + 问卷交互
│   ├── questionnaire.js    # 手部自评问卷题库与评分规则（23 题 / 4 组）
│   ├── assets/q21-thumb-wrist-steps.png  # 第 21 题自测姿势图
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
  - `submit_assessment` 提交问卷结果（网页「手部评估」页）
  - `get_latest_assessment` / `get_assessments` 读取最近一次与历史评估
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

## 手部评估问卷

题库与评分规则来自「舒腕知护」桌面版（`resources/app.asar` 内的 `questionnaire.js`），已完整移植到
`web/questionnaire.js`，与桌面版的 23 道题、4 个分组、评分口径完全一致：

| 项 | 规则 |
|---|---|
| 分组 | ① 认识你的双手 Q1–Q6　② 了解日常用手习惯 Q7–Q11　③ 听听身体的感受 Q12–Q21　④ 看看日常活动的变化 Q22–Q23 |
| 症状与功能 | Q12–Q21（10 项）+ Q22（9 个子项），每题 0–4 分，合计 **0–76** |
| 日常负荷 | Q7 选中项数 + Q8/Q9/Q10 权重（0/1/2/3）+ Q11 选中项数，合计 **0–16** |
| 基准等级 | ≤38 低风险，39–57 中风险，≥58 高风险 |
| 等级修正 | 日常负荷 ≥8 分时风险上调一级（封顶高风险）；4–7 分只提示不改等级 |
| 不参与计分 | Q23（仅作补充描述）、Q1–Q6（背景信息，用于提示文案） |
| 条件题 | Q2 仅在 Q1 选择「女」时出现 |
| 必答 | Q21 为必答自测题，附姿势图 `assets/q21-thumb-wrist-steps.png` 与三步说明 |

交互：分 4 组逐步填写，跨越「上一步/继续」或「提交」时校验本组/全部题目；选项点选即存草稿到
`localStorage`（键 `handguard_assess_<账号ID>`），提交成功后清草稿并通过 `submit_assessment` 落库。
看板「手部评估」卡片展示最近一次结果（等级、0–76、0–16、基准等级、提示文案）。

题库改动的落点只有一处：`web/questionnaire.js`（`docs/` 为发布副本，需同步）。若评分规则调整，
`supabase/schema.sql` 中 `assessments` 表的 `core_score` / `exposure` / `risk_level` 由前端传入，
服务端不再复算，因此前后端只需保持 schema 列不变。