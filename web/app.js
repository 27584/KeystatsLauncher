/* ==========================================================================
  手护 · 手部健康监测 — 前端逻辑
  通过 Supabase RPC 函数读写（schema.sql 中的 SECURITY DEFINER 函数）。
  图表为原生 SVG 渲染，无第三方图表库；无 emoji，全部 SVG 图标。
  ========================================================================== */

(function () {
  "use strict";

  const CFG = window.__SUPABASE_CONFIG__ || {};
  const SECOND = 1000;
  const STORE_KEY = "handguard_session";

  let sb = null;
  let currentUser = null; // { id }
  let currentDevice = null; // string | null（选中的设备 uuid；null 表示汇总全部）

  // ---------- 基础 ----------
  function $(sel) { return document.querySelector(sel); }

  function initSupabase() {
    if (typeof window.supabase === "undefined") {
      toast("加载 Supabase SDK 失败", "err");
      return;
    }
    if (!CFG.url || CFG.url.includes("YOUR_")) {
      toast("请先在 web/config.js 配置 Supabase 地址与公钥", "err");
      return;
    }
    sb = window.supabase.createClient(CFG.url, CFG.publishableKey);
  }

  function toast(msg, type) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast " + (type || "");
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  const ICONS = {
    keys: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="8" rx="2"/><path d="M3 17h18M8 9h.01M12 9h.01M16 9h.01M8 13v4M12 13v4M16 13v4"/></svg>',
    clicks: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l9 6-4 2-2 4z"/></svg>',
    move: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M12 3v4"/><circle cx="12" cy="11" r="2.5"/><path d="M4 17c0-1.1 3.6-2 8-2s8 .9 8 2M5 20h14"/></svg>',
    scroll: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>',
    advice: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 4 5 .8-3.6 3.5.9 5L12 14.5 7.3 16.3l.9-5L4.6 7.8l5-.8z"/></svg>'
  };

  // ---------- 图标组件树（stat 卡片） ----------
  function statCard(label, value, sub, icon) {
    return '<div class="stat"><span class="label">' + icon + label + '</span>' +
      '<div class="value">' + value + '</div>' +
      (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
  }

  // ---------- SVG 图表 ----------
  // lineChart：折线图（面积填充 + 数据点标注）
  function renderLine(el, labels, series, opts) {
    opts = opts || {};
    const W = 560, H = 200, PL = 38, PR = 14, PT = 14, PB = 30;
    const iw = W - PL - PR, ih = H - PT - PB;
    const max = Math.max(1, Math.max.apply(null, series));
    const stepX = series.length > 1 ? iw / (series.length - 1) : iw;

    let y = function (v) { return PT + ih - (v / max) * ih; };
    let pts = series.map(function (v, i) { return [PL + i * stepX, y(v)]; });
    let line = pts.map(function (p) { return p[0] + "," + p[1]; }).join(" ");

    let area = PL + "," + (PT + ih) + " " + line + " " + (PL + (series.length - 1) * stepX) + "," + (PT + ih);
    let xTicks = labels.map(function (l, i) {
      if (labels.length > 14 && i % Math.ceil(labels.length / 8) !== 0) return "";
      return '<text x="' + (PL + i * stepX) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--text-2)">' + l + "</text>";
    }).join("");
    let grid = [0, 0.25, 0.5, 0.75, 1].map(function (g) {
      let gy = y(max * g);
      return '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="var(--line)" stroke-width="1"/>';
    }).join("");
    let dots = pts.map(function (p) {
      return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.5" fill="var(--primary)"/>';
    }).join("");

    el.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" aria-label="折线图">' +
      grid +
      '<polygon points="' + area + '" fill="var(--primary)" opacity="0.10"/>' +
      '<polyline points="' + line + '" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + xTicks + "</svg>";
  }

  // barChart：柱状图
  function renderBars(el, labels, series, color) {
    color = color || "var(--primary)";
    const W = 560, H = 200, PL = 38, PR = 14, PT = 14, PB = 30;
    const iw = W - PL - PR, ih = H - PT - PB;
    const max = Math.max(1, Math.max.apply(null, series));
    let n = series.length, slot = iw / n, barW = Math.min(30, slot * 0.55);

    let bars = series.map(function (v, i) {
      let h = (v / max) * ih, x = PL + i * slot + (slot + barW) / 2;
      return '<rect x="' + x + '" y="' + (PT + ih - h) + '" width="' + barW + '" height="' + h + '" rx="2" fill="' + color + '"/>';
    }).join("");
    let xTicks = labels.map(function (l, i) {
      if (labels.length > 14 && i % Math.ceil(labels.length / 8) !== 0) return "";
      return '<text x="' + (PL + i * slot + slot / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--text-2)">' + l + "</text>";
    }).join("");

    el.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" aria-label="柱状图">' +
      '<line x1="' + PL + '" y1="' + (PT + ih) + '" x2="' + (W - PR) + '" y2="' + (PT + ih) + '" stroke="var(--line)"/>' +
      bars + xTicks + "</svg>";
  }

  // ---------- 数据聚合 ----------
  // snapshots 来自 get_health_snapshots，按天聚合（取每天最后一次）
  function aggregateByDate(snaps) {
    let map = {};
    snaps.forEach(function (s) {
      map[s.stats_date] = s; // 已按 uploaded_at 升序，后面的覆盖 = 当日最新
    });
    return Object.keys(map).sort().map(function (d) { return map[d]; });
  }

  function fmt(n) {
    if (n == null) return "0";
    if (n >= 10000) return (n / 10000).toFixed(1) + " 万";
    if (n >= 1000) return (n / 1000).toFixed(1) + " k";
    return String(Math.round(n));
  }

  // ---------- 健康建议（基于强度） ----------
  function buildAdvice(snaps) {
    const total = aggregateByDate(snaps);
    const day = total[total.length - 1];
    if (!day) return [{ lv: "暂无数据", msg: "尚未收到该设备的上传数据，设备每秒采集后每 5 分钟同步一次。" }];

    const kps = day.key_presses || 0;
    const clicks = (day.left_clicks || 0) + (day.right_clicks || 0) + (day.middle_clicks || 0) + (day.side_back_clicks || 0) + (day.side_forward_clicks || 0);
    const moveM = (day.mouse_distance || 0) / 20000; // 像素 → 米（与 KeyStats 一致）
    const peak = Math.max(day.peak_kps || 0, day.peak_cps || 0);

    let advice = [];
    if (kps > 12000) advice.push({ lv: "高", msg: "今日按键量明显偏多，建议每 45 分钟停下伸展手腕。" });
    else if (kps > 6000) advice.push({ lv: "中", msg: "按键强度适中，留意是否有手腕酸胀感。" });
    else if (kps > 0) advice.push({ lv: "低", msg: "按键强度处于舒适区间，继续保持劳逸节奏。" });

    if (moveM > 15) advice.push({ lv: "高", msg: "鼠标移动距离较大，注意调整握姿，避免长时间悬腕。" });

    if (peak >= 6) advice.push({ lv: "高", msg: "存在高频连点（峰值 " + peak.toFixed(1) + " cps），短时高负荷操作后请放松手部。" });
    else if (peak > 0) advice.push({ lv: "低", msg: "操作频率平稳，腕部压力在安全范围内。" });

    if (!advice.length) advice.push({ lv: "-", msg: "今日尚无数据，完成首次上传后这里会出现针对性建议。" });

    // 附加一条「本周」对比
    if (total.length >= 2) {
      const prev = total[total.length - 2];
      if (prev && (prev.key_presses || 0) > 0) {
        const delta = Math.round(((day.key_presses - prev.key_presses) / prev.key_presses) * 100);
        if (delta > 20) advice.push({ lv: "↑" + delta + "%", msg: "按键量较上日明显上升，今天注意多休息。" });
        else if (delta < -20) advice.push({ lv: "↓" + Math.abs(delta) + "%", msg: "按键量较上日下降，恢复节奏很好。" });
      }
    }
    return advice.slice(0, 5);
  }

  // ---------- 渲染看板 ----------
  function renderDashboard(snaps) {
    const days = aggregateByDate(snaps);
    const last14 = days.slice(-14);
    const day = days[days.length - 1];

    const kpsRange = days.length ? (last14.length ? last14[0].stats_date + " → " + last14[last14.length - 1].stats_date : day.stats_date) : "-";
    $("#kpsRange").textContent = kpsRange;

    // 概览
    let statHTML;
    if (!day) {
      statHTML = statCard("按键", "0", "暂无数据", ICONS.keys) +
        statCard("鼠标点击", "0", "暂无数据", ICONS.clicks) +
        statCard("移动距离", "0 m", "暂无数据", ICONS.move) +
        statCard("峰值效率", "0", "KPS / CPS", ICONS.scroll);
    } else {
      const clicks = (day.left_clicks || 0) + (day.right_clicks || 0) + (day.middle_clicks || 0) + (day.side_back_clicks || 0) + (day.side_forward_clicks || 0);
      const moveM = (day.mouse_distance || 0) / 20000;
      statHTML =
        statCard("今日按键", fmt(day.key_presses), "峰值 " + fmt(day.peak_kps || 0) + " KPS", ICONS.keys) +
        statCard("鼠标点击", fmt(clicks), "左键 " + fmt(day.left_clicks || 0), ICONS.clicks) +
        statCard("移动距离", moveM.toFixed(1) + " m", "滚轮 " + fmt(day.scroll_distance || 0) + " px", ICONS.move) +
        statCard("峰值效率", (day.peak_kps || 0).toFixed(1) + " KPS", "CPS " + (day.peak_cps || 0).toFixed(1), ICONS.scroll);
    }
    $("#statGrid").innerHTML = statHTML;

    // 图表
    const labels = last14.map(function (d) { return d.stats_date.slice(5); }); // MM-DD
    const keysV = last14.map(function (d) { return d.key_presses || 0; });
    const clickV = last14.map(function (d) { return (d.left_clicks || 0) + (d.right_clicks || 0) + (d.middle_clicks || 0) + (d.side_back_clicks || 0) + (d.side_forward_clicks || 0); });
    const moveV = last14.map(function (d) { return (d.mouse_distance || 0) / 20000; }); // 米

    renderLine($("#chartKeys"), labels, keysV);
    renderBars($("#chartClicks"), labels, clickV);
    renderLine($("#chartMove"), labels, moveV, { area: true });

    // 建议
    const advice = buildAdvice(days);
    $("#adviceList").innerHTML = advice.map(function (a) {
      return '<li><span class="ico">' + ICONS.advice + '</span><span>' + a.msg + '</span><span class="lvl">' + a.lv + "</span></li>";
    }).join("");
  }

  // ---------- 使用速率 ----------
  // 基于同一天内多次上报的数值差 ÷ 时间差，估算单位时间内的操作强度。
  // snapshots 为原始（未按天聚合）数据，需含 datetime。
  function renderRate(snaps) {
    const el = $("#chartRate");
    if (!snaps || !snaps.length) {
      el.innerHTML = '<div class="chart-empty">尚无当天多次上报数据，无法计算速率</div>';
      return;
    }
    // 取最近一天的全部上报，按时间升序
    const lastDate = snaps[snaps.length - 1].stats_date;
    const daySnaps = snaps.filter(function (s) { return s.stats_date === lastDate; });

    // 计算相邻上报的速率（按键/min、点击/min）
    const tLabels = [], keyRates = [], clickRates = [];
    for (let i = 1; i < daySnaps.length; i++) {
      const a = daySnaps[i - 1], b = daySnaps[i];
      const dtMin = (new Date(b.uploaded_at) - new Date(a.uploaded_at)) / 60000;
      if (!(dtMin > 0)) continue; // 时间差无效则跳过
      const dKeys = (b.key_presses || 0) - (a.key_presses || 0);
      const dClicks = ((b.left_clicks || 0) + (b.right_clicks || 0) + (b.middle_clicks || 0) + (b.side_back_clicks || 0) + (b.side_forward_clicks || 0))
        - ((a.left_clicks || 0) + (a.right_clicks || 0) + (a.middle_clicks || 0) + (a.side_back_clicks || 0) + (a.side_forward_clicks || 0));
      // 时间标签用小端时刻（b 的时间，MM-DD HH:MM）
      const d = new Date(b.uploaded_at);
      const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
      tLabels.push(hh + ":" + mm);
      keyRates.push(Number((dKeys / dtMin).toFixed(1)));
      clickRates.push(Number(((dClicks / dtMin)).toFixed(1)));
    }

    if (!keyRates.length) {
      el.innerHTML = '<div class="chart-empty">当天仅一次上报，暂无法计算速率差</div>';
      return;
    }
    $("#rateRange").textContent = lastDate.slice(5) + " 当日";

    // 双折线：按键/分钟 与 点击/分钟
    const W = 560, H = 200, PL = 38, PR = 14, PT = 14, PB = 30;
    const iw = W - PL - PR, ih = H - PT - PB;
    const max = Math.max(1, Math.max.apply(null, keyRates.concat(clickRates)));
    const stepX = iw / (keyRates.length - 1 || 1);
    const xs = function (i) { return PL + i * stepX; };
    const y = function (v) { return PT + ih - (v / max) * ih; };
    const line = function (arr) { return arr.map(function (v, i) { return xs(i) + "," + y(v); }).join(" "); };
    let xTicks = tLabels.map(function (l, i) {
      if (tLabels.length > 9 && i % Math.ceil(tLabels.length / 6) !== 0) return "";
      return '<text x="' + xs(i) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--text-2)">' + l + "</text>";
    }).join("");
    let grid = [0, 0.25, 0.5, 0.75, 1].map(function (g) {
      let gy = y(max * g);
      return '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="var(--line)" stroke-width="1"/>';
    }).join("");
    let legend =
      '<line x1="' + (PL) + '" y1="' + (PT - 6) + '" x2="' + (PL + 14) + '" y2="' + (PT - 6) + '" stroke="var(--primary)" stroke-width="2"/>' +
      '<text x="' + (PL + 18) + '" y="' + (PT - 3) + '" font-size="11" fill="var(--text-2)">按键/分</text>' +
      '<line x1="' + (PL + 90) + '" y1="' + (PT - 6) + '" x2="' + (PL + 104) + '" y2="' + (PT - 6) + '" stroke="var(--success)" stroke-width="2"/>' +
      '<text x="' + (PL + 108) + '" y="' + (PT - 3) + '" font-size="11" fill="var(--text-2)">点击/分</text>';

    el.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" aria-label="速率曲线">' +
      legend + grid +
      '<polyline points="' + line(keyRates) + '" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<polyline points="' + line(clickRates) + '" fill="none" stroke="var(--success)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      keyRates.map(function (v, i) { return '<circle cx="' + xs(i) + '" cy="' + y(v) + '" r="2.5" fill="var(--primary)"/>'; }).join("") +
      clickRates.map(function (v, i) { return '<circle cx="' + xs(i) + '" cy="' + y(v) + '" r="2.5" fill="var(--success)"/>'; }).join("") +
      xTicks + "</svg>";
  }

  // ---------- 加载数据 ----------
  async function loadDashboard() {
    if (!currentUser) return;
    try {
      const { data, error } = await sb.rpc("get_health_snapshots", {
        p_user_id: currentUser.id, p_days: 30, p_device_uuid: currentDevice
      });
      if (error) throw error;
      renderDashboard(data || []);
      renderRate(data || []);
    } catch (e) {
      toast("加载数据失败：" + (e.message || e), "err");
    }
  }

  async function loadDevices() {
    const list = $("#deviceList");
    try {
      const { data, error } = await sb.rpc("get_user_devices", { p_user_id: currentUser.id });
      if (error) throw error;
      const dot = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h6M10 13l1.5 1.5L15 11"/></svg>';

      const label = function (d) { return d.device_name || d.device_uuid.slice(0, 8); };

      // 填充设备下拉（保留当前选中）
      const sel = $("#deviceSelect");
      const prev = currentDevice;
      sel.innerHTML =
        '<option value="">全部设备</option>' +
        (data || []).map(function (d) {
          return '<option value="' + d.device_uuid + '">' + label(d) + "</option>";
        }).join("");
      if (prev && (data || []).some(function (d) { return d.device_uuid === prev; })) {
        sel.value = prev;
      } else {
        sel.value = ""; // 上次选中的设备可能已解绑，回落到全部
        currentDevice = null;
      }

      if (!data || !data.length) {
        list.innerHTML = '<li class="empty" id="deviceEmpty">暂无绑定设备。在电脑的启动器窗口查看 6 位验证码，输入下方即可绑定。</li>';
        return;
      }
      list.innerHTML = data.map(function (d) {
        return '<li><span class="device-ico">' + dot + '</span><span class="device-meta"><b>' +
          label(d) + "</b> · " +
          (d.bound_at ? "绑定于 " + String(d.bound_at).slice(0, 10) : "") +
          "</span></li>";
      }).join("");
    } catch (e) {
      list.innerHTML = '<li class="empty">加载设备失败：' + (e.message || e) + "</li>";
    }
  }

  // ---------- 登录 / 绑定 ----------
  async function bindDevice(code) {
    try {
      const { data, error } = await sb.rpc("bind_device", { p_bind_code: code, p_user_id: currentUser.id });
      if (error) throw error;
      if (!data) return { ok: false, msg: "验证码无效或已过期" };
      await loadDevices();
      return { ok: true, msg: "绑定成功" };
    } catch (e) {
      return { ok: false, msg: "绑定失败：" + (e.message || e) };
    }
  }

  // ---------- 六格验证码输入 ----------
  // 真实输入走贴纸在格子上方的透明 input；输入自动剔除空格，值同步到格子。
  function initBindCode() {
    const box = $("#codeInput");
    if (!box) return;
    const inp = box.querySelector("input");
    box.addEventListener("click", function () { inp.focus(); });
    inp.addEventListener("input", syncBindCode);
    syncBindCode();
  }
  function syncBindCode() {
    const box = $("#codeInput");
    if (!box) return;
    const inp = box.querySelector("input");
    const v = inp.value.replace(/\s+/g, "").slice(0, 6); // 自动省略空格
    inp.value = v;
    const slots = box.querySelectorAll("span");
    for (let i = 0; i < slots.length; i++) {
      const ch = v[i] || "";
      slots[i].textContent = ch;
      slots[i].classList.toggle("filled", !!ch);
    }
  }

  // ---------- 视图切换 ----------
  function switchView(name) {
    ["dashboard", "bind", "login"].forEach(function (v) {
      $("#view-" + v).hidden = v !== name;
    });
    document.querySelectorAll(".nav-link").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === name);
    });
  }

  function enterApp(user) {
    currentUser = user;
    $("#accountId").textContent = user.id;
    $("#topbar").hidden = false;
    switchView("dashboard");
    loadDevices().then(function () { loadDashboard(); });
  }

  // ---------- 事件绑定 ----------
  function boot() {
    initSupabase();

    $("#loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      const id = $("#loginId").value.trim();
      if (!id) return toast("请输入账号 ID", "err");
      try { localStorage.setItem(STORE_KEY, id); } catch (_) {}
      enterApp({ id: id });
    });

    $("#btnLogout").addEventListener("click", function () {
      try { localStorage.removeItem(STORE_KEY); } catch (_) {}
      currentUser = null;
      $("#topbar").hidden = true;
      switchView("login");
    });

    document.querySelectorAll(".nav-link").forEach(function (b) {
      b.addEventListener("click", function () {
        switchView(b.dataset.view);
        if (b.dataset.view === "bind") loadDevices();
        if (b.dataset.view === "dashboard") loadDashboard();
      });
    });

    $("#deviceSelect").addEventListener("change", function () {
      currentDevice = this.value || null;
      loadDashboard();
    });

    $("#bindForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      const code = $("#bindCode").value.trim();
      if (!/^[A-Za-z0-9]{6}$/.test(code)) return toast("请输入 6 位验证码", "err");
      const btn = this.querySelector("button");
      btn.disabled = true;
      const r = await bindDevice(code.toUpperCase());
      btn.disabled = false;
      toast(r.msg, r.ok ? "ok" : "err");
      if (r.ok) { $("#bindCode").value = ""; syncBindCode(); }
    });

    initBindCode();

    // 恢复会话
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (_) {}
    if (saved) enterApp({ id: saved });
    else switchView("login");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();