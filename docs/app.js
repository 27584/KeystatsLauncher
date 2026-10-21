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
  function statCard(label, value, sub, icon, tip) {
    return '<div class="stat"' + (tip ? ' data-tip="' + tip + '"' : '') + '>' +
      '<span class="label">' + icon + label + '</span>' +
      '<div class="value">' + value + '</div>' +
      (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
  }

  // ---------- SVG 图表 ----------
  // 尺寸策略：viewBox 直接取容器内容区的 CSS 像素尺寸，令 1 用户单位 = 1 CSS px。
  // 这样横纵缩放系数恒等 —— 圆点是正圆、线宽处处一致、坐标与图例文字不被拉宽。
  // 反例（旧实现）：viewBox 固定 560×200 + width/height 100% + preserveAspectRatio="none"，
  // 容器一旦不是 2.8:1（宽屏 + 固定 height:240px 必然如此），整张图就被横向拉伸：
  // r=3 的圆点变成扁椭圆、竖直段比水平段粗近一倍、SVG 文字横向拉宽 —— 且宽高比越极端越严重。
  function chartSize(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const w = r.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const h = r.height - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    return { W: Math.max(160, Math.round(w) || 0), H: Math.max(110, Math.round(h) || 0) };
  }

  // 容器尺寸变化时按同一套参数重绘（窗口缩放、图表网格换行）。
  // 只在实测尺寸变化时重绘，避免「重绘 → 尺寸变化 → 重绘」的自激循环。
  const REDRAW = [];
  let redrawRO = null;
  function autoRedraw(el, fn) {
    let rec = null;
    for (let i = 0; i < REDRAW.length; i++) {
      if (REDRAW[i].el === el) { rec = REDRAW[i]; break; }
    }
    if (!rec) { rec = { el: el, fn: null, W: 0, H: 0 }; REDRAW.push(rec); }
    rec.fn = fn;
    const s = chartSize(el);
    rec.W = s.W; rec.H = s.H;
    if (!redrawRO && typeof ResizeObserver !== "undefined") {
      redrawRO = new ResizeObserver(function (entries) {
        for (let i = 0; i < entries.length; i++) {
          const target = entries[i].target;
          for (let j = 0; j < REDRAW.length; j++) {
            const r2 = REDRAW[j];
            if (r2.el !== target || !r2.fn) continue;
            const s2 = chartSize(target);
            if (s2.W === r2.W && s2.H === r2.H) continue; // 尺寸没变，跳过
            r2.W = s2.W; r2.H = s2.H;
            r2.fn();
          }
        }
      });
    }
    if (redrawRO) { try { redrawRO.observe(el); } catch (_) {} }
  }
  function stopRedraw(el) {
    for (let i = 0; i < REDRAW.length; i++) {
      if (REDRAW[i].el === el) { REDRAW[i].fn = null; break; }
    }
    if (redrawRO) { try { redrawRO.unobserve(el); } catch (_) {} }
  }

  // bindChartHover：图表悬停交互（参考线 + 高亮数据点 + 数值 tooltip）
  // 鼠标扫过绘图区任意位置即触发，无需精确命中数据点
  function bindChartHover(el, labels, seriesList, o) {
    const svg = el.querySelector("svg");
    const tipEl = document.getElementById("ui-tip");
    if (!svg || !tipEl) return;
    const ns = "http://www.w3.org/2000/svg";
    // 垂直参考线
    const rl = document.createElementNS(ns, "line");
    rl.setAttribute("stroke", "var(--text-2)");
    rl.setAttribute("stroke-dasharray", "3 3");
    rl.setAttribute("stroke-width", "1");
    rl.setAttribute("y1", o.PT);
    rl.setAttribute("y2", o.PT + o.ih);
    rl.style.pointerEvents = "none";
    rl.style.display = "none";
    svg.appendChild(rl);
    // 各系列高亮点
    const dots = seriesList.map(function (s) {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("r", "3.5");
      c.setAttribute("fill", s.color);
      c.style.pointerEvents = "none";
      c.style.display = "none";
      svg.appendChild(c);
      return c;
    });
    const maxY = o.max || 1;
    function onMove(ev) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const scale = o.W / rect.width;
      const vx = (ev.clientX - rect.left) * scale;
      if (vx < o.PL - 2 || vx > o.W - o.PR + 2) { hide(); return; }
      let i = o.vxToIndex(vx);
      i = Math.max(0, Math.min(labels.length - 1, i));
      const x = o.xOf(i);
      rl.setAttribute("x1", x); rl.setAttribute("x2", x); rl.style.display = "";
      seriesList.forEach(function (s, si) {
        // 每条系列可用自己的 max（双 Y 轴），如未指定则回退到公共 o.max
        const sy = s.max || maxY;
        const y = o.PT + o.ih - (s.arr[i] / sy) * o.ih;
        dots[si].setAttribute("cx", x); dots[si].setAttribute("cy", y); dots[si].style.display = "";
      });
      tipEl.textContent = o.fmt(i);
      tipEl.hidden = false;
      // 用 SVG 真实坐标矩阵把数据点(viewBox)映射到屏幕，跟随参考线顶、不遮挡图例
      let sx, syTop;
      if (svg.getScreenCTM && svg.createSVGPoint) {
        const pt = svg.createSVGPoint(); pt.x = x; pt.y = o.PT;
        const sp = pt.matrixTransform(svg.getScreenCTM());
        sx = sp.x; syTop = sp.y;
      } else {
        const r = svg.getBoundingClientRect();
        sx = r.left + (x / o.W) * r.width;
        syTop = r.top + (o.PT / (o.H || 200)) * r.height;
      }
      let tx = sx + 12;
      let ty = syTop + 6; // 落在图例下方、绘图区顶部，不压住"按键/分·点击/分"
      if (tx + 220 > innerWidth) tx = sx - 220 - 12;
      tipEl.style.left = tx + "px";
      tipEl.style.top = ty + "px";
    }
    function hide() {
      rl.style.display = "none";
      dots.forEach(function (d) { d.style.display = "none"; });
      tipEl.hidden = true;
    }
    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseleave", hide);
  }
  // lineChart：折线图（面积填充 + 数据点标注）
  function renderLine(el, labels, series, opts) {
    opts = opts || {};
    const sz = chartSize(el), W = sz.W, H = sz.H;
    const PL = 38, PR = 14, PT = 14, PB = 30;
    const iw = Math.max(20, W - PL - PR), ih = Math.max(20, H - PT - PB);
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
      return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="var(--primary)"/>';
    }).join("");

    el.innerHTML =
      '<svg class="chart-hover" viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" aria-label="折线图">' +
      grid +
      '<polygon points="' + area + '" fill="var(--primary)" opacity="0.10"/>' +
      '<polyline points="' + line + '" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + xTicks + "</svg>";

    bindChartHover(el, labels, [{ arr: series, color: "var(--primary)" }], {
      PL: PL, W: W, PR: PR, PT: PT, ih: ih, max: max, H: H,
      xOf: function (i) { return PL + i * stepX; },
      vxToIndex: function (vx) { return Math.round((vx - PL) / stepX); },
      fmt: function (i) { return labels[i] + "：" + fmt(series[i]); }
    });
    autoRedraw(el, function () { renderLine(el, labels, series, opts); });
  }

  // barChart：柱状图
  function renderBars(el, labels, series, color) {
    color = color || "var(--primary)";
    const sz = chartSize(el), W = sz.W, H = sz.H;
    const PL = 38, PR = 14, PT = 14, PB = 30;
    const iw = Math.max(20, W - PL - PR), ih = Math.max(20, H - PT - PB);
    const max = Math.max(1, Math.max.apply(null, series));
    let n = series.length, slot = iw / n, barW = Math.min(30, slot * 0.55);

    let bars = series.map(function (v, i) {
      // 柱心必须落在槽中心（与 xTicks / bindChartHover 的 xOf 一致）：
      // 槽 i 占据 [PL + i*slot, PL + (i+1)*slot]，柱宽 barW ⇒ 左边界 = PL + i*slot + (slot - barW)/2。
      // 曾写成 (slot + barW)/2 —— 等于把每根柱子右推一个柱宽，柱心与刻度标签错位。
      let h = (v / max) * ih, x = PL + i * slot + (slot - barW) / 2;
      return '<rect x="' + x + '" y="' + (PT + ih - h) + '" width="' + barW + '" height="' + h + '" rx="2" fill="' + color + '"/>';
    }).join("");
    let xTicks = labels.map(function (l, i) {
      if (labels.length > 14 && i % Math.ceil(labels.length / 8) !== 0) return "";
      return '<text x="' + (PL + i * slot + slot / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--text-2)">' + l + "</text>";
    }).join("");

    el.innerHTML =
      '<svg class="chart-hover" viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" aria-label="柱状图">' +
      '<line x1="' + PL + '" y1="' + (PT + ih) + '" x2="' + (W - PR) + '" y2="' + (PT + ih) + '" stroke="var(--line)"/>' +
      bars + xTicks + "</svg>";

    bindChartHover(el, labels, [{ arr: series, color: color }], {
      PL: PL, W: W, PR: PR, PT: PT, ih: ih, max: max, H: H,
      xOf: function (i) { return PL + i * slot + slot / 2; },
      vxToIndex: function (vx) { return Math.round((vx - PL) / slot - 0.5); },
      fmt: function (i) { return labels[i] + "：" + fmt(series[i]); }
    });
    autoRedraw(el, function () { renderBars(el, labels, series, color); });
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
      statHTML = statCard("按键", "0", "暂无数据", ICONS.keys, "今日键盘按键总次数") +
        statCard("鼠标点击", "0", "暂无数据", ICONS.clicks, "今日鼠标点击总次数（左/右/中/侧键）") +
        statCard("移动距离", "0 m", "暂无数据", ICONS.move, "鼠标移动总距离（像素换算为米）") +
        statCard("峰值效率", "0", "KPS / CPS", ICONS.scroll, "短时最高每秒按键 / 点击次数");
    } else {
      const clicks = (day.left_clicks || 0) + (day.right_clicks || 0) + (day.middle_clicks || 0) + (day.side_back_clicks || 0) + (day.side_forward_clicks || 0);
      const moveM = (day.mouse_distance || 0) / 20000;
      statHTML =
        statCard("今日按键", fmt(day.key_presses), "峰值 " + fmt(day.peak_kps || 0) + " KPS", ICONS.keys, "今日键盘按键总次数") +
        statCard("鼠标点击", fmt(clicks), "左键 " + fmt(day.left_clicks || 0), ICONS.clicks, "今日鼠标点击总次数（左/右/中/侧键）") +
        statCard("移动距离", moveM.toFixed(1) + " m", "滚轮 " + fmt(day.scroll_distance || 0) + " px", ICONS.move, "鼠标移动总距离（像素换算为米）") +
        statCard("峰值效率", (day.peak_kps || 0).toFixed(1) + " KPS", "CPS " + (day.peak_cps || 0).toFixed(1), ICONS.scroll, "短时最高每秒按键 / 点击次数");
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
      stopRedraw(el);
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
      stopRedraw(el);
      el.innerHTML = '<div class="chart-empty">当天仅一次上报，暂无法计算速率差</div>';
      return;
    }
    $("#rateRange").textContent = lastDate.slice(5) + " 当日";

    // 双折线：按键/分钟 与 点击/分钟
    const sz = chartSize(el), W = sz.W, H = sz.H;
    const PL = 38, PR = 14, PT = 14, PB = 30;
    const iw = Math.max(20, W - PL - PR), ih = Math.max(20, H - PT - PB);
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
      '<svg class="chart-hover" viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" aria-label="速率曲线">' +
      legend + grid +
      '<polyline points="' + line(keyRates) + '" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<polyline points="' + line(clickRates) + '" fill="none" stroke="var(--success)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      keyRates.map(function (v, i) { return '<circle cx="' + xs(i) + '" cy="' + y(v) + '" r="3" fill="var(--primary)"/>'; }).join("") +
      clickRates.map(function (v, i) { return '<circle cx="' + xs(i) + '" cy="' + y(v) + '" r="3" fill="var(--success)"/>'; }).join("") +
      xTicks + "</svg>";

    bindChartHover(el, tLabels, [
      { arr: keyRates, color: "var(--primary)" },
      { arr: clickRates, color: "var(--success)" }
    ], {
      PL: PL, W: W, PR: PR, PT: PT, ih: ih, max: max, H: H,
      xOf: function (i) { return PL + i * stepX; },
      vxToIndex: function (vx) { return Math.round((vx - PL) / stepX); },
      fmt: function (i) { return tLabels[i] + "：按键 " + keyRates[i] + " 次/分，点击 " + clickRates[i] + " 次/分"; }
    });
    autoRedraw(el, function () { renderRate(snaps); });
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

  // ---------- Tooltip（事件委托，动态元素同样生效） ----------
  // mouseover 统一决定显隐（移到 data-tip 元素上显示，移出即隐藏），
  // mousemove 只负责跟随定位 —— 避免鼠标在小范围移动时闪烁。
  function initTooltip() {
    const tip = document.createElement("div");
    tip.id = "ui-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
    let active = null;
    document.addEventListener("mouseover", function (e) {
      const t = (e.target.closest && e.target.closest("[data-tip]")) || null;
      if (t) {
        active = t;
        tip.textContent = t.getAttribute("data-tip");
        tip.hidden = false;
      } else {
        // 图表区由 bindChartHover 接管，不在此强制隐藏
        if (!(e.target && e.target.closest && e.target.closest(".chart-hover"))) {
          active = null;
          tip.hidden = true;
        }
      }
    });
    document.addEventListener("mousemove", function (e) {
      // 图表区位置由 bindChartHover 接管，避免本处理把 tip 拽回光标旁
      if (e.target && e.target.closest && e.target.closest(".chart-hover")) return;
      if (!active) return;
      const pad = 12;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + 220 > innerWidth) x = e.clientX - 220 - pad;
      if (y + 60 > innerHeight) y = e.clientY - 60 - pad;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    });
  }

  // ---------- 手部评估问卷 ----------
  // 题库与算分规则来自 questionnaire.js（与桌面版「舒腕知护」一致）。
  // 作答草稿存在本机，提交后由 Supabase RPC 落库，看板读取最近一次结果。
  const QUES = window.HG_QUES || {
    groups: [], questions: [],
    missingAnswers: function () { return []; },
    evaluate: function () { return { complete: false, missing: [] }; },
    riskNames: ["低风险", "中风险", "高风险"],
    riskSummary: ["", "", ""]
  };
  const ASSESS_KEY = "handguard_assess_";
  let assess = null;          // { answers, group, errors }
  let latestAssessment = null; // 后端最近一次评估行

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function draftKey() { return ASSESS_KEY + (currentUser ? currentUser.id : "anon"); }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(draftKey());
      if (raw) {
        const o = JSON.parse(raw);
        if (o && typeof o === "object") return o;
      }
    } catch (_) {}
    return {};
  }

  function saveDraft() {
    try { localStorage.setItem(draftKey(), JSON.stringify(assess.answers)); } catch (_) {}
  }

  // 首个未作答的题号所在分组，用于「继续上次填写」
  function firstGroupWithMissing(answers) {
    const missing = QUES.missingAnswers(answers || {});
    if (!missing.length) return 0;
    for (let i = 0; i < QUES.groups.length; i++) {
      const r = QUES.groups[i].range;
      if (missing[0] >= r[0] && missing[0] <= r[1]) return i;
    }
    return 0;
  }

  function optHTML(q, i, label, on, row) {
    return '<button type="button" class="opt' + (on ? " on" : "") + '"' +
      ' data-q="' + q.id + '" data-i="' + i + '" data-j="' + row + '"' +
      ' aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + "</button>";
  }

  // 第 21 题：自测姿势图 + 三步说明（与桌面版一致）
  function q21Figure() {
    return '<figure class="q21">' +
      '<div class="q21-img"><img src="assets/q21-thumb-wrist-steps.png" alt="自测三步：拇指弯入掌心，四指轻握包住拇指，手腕轻向小指侧偏移；右手示意" loading="lazy">' +
      "<span>右手示意 · 左手按对应方向操作</span></div>" +
      "<figcaption><div class=\"eyebrow\">自测姿势 · 三步看懂</div><ol>" +
      "<li><strong>拇指放入掌心</strong><p>先让手腕自然放平，将拇指轻轻弯向掌心。</p></li>" +
      "<li><strong>其余四指轻握</strong><p>四指包住拇指，拇指留在拳内，不要用力攥紧。</p></li>" +
      "<li><strong>轻向小指侧偏移</strong><p>轻轻向小指方向偏移手腕，留意拇指侧手腕的感受，不是向拇指侧弯。</p></li>" +
      "</ol><p class=\"q21-safety\">出现明显疼痛即停止，不用另一只手强压，不要反复测试。图示用于理解问卷动作，不能用于确诊。</p></figcaption></figure>";
  }

  function questionHTML(q) {
    const v = assess.answers[q.id];
    const bad = assess.errors.indexOf(q.id) >= 0;
    let body;
    if (q.matrix) {
      body = q.matrix.map(function (row, j) {
        return '<div class="mtx-row"><p class="mtx-label">' + (j + 1) + ". " + esc(row) + "</p>" +
          '<div class="opts opts-mtx">' + q.options.map(function (o, i) {
            return optHTML(q, i, o, Array.isArray(v) && v[j] === i, j);
          }).join("") + "</div></div>";
      }).join("");
    } else {
      body = '<div class="opts">' + q.options.map(function (o, i) {
        var on = q.multi ? (Array.isArray(v) && v.indexOf(i) >= 0) : v === i;
        return optHTML(q, i, o, on, -1);
      }).join("") + "</div>";
    }
    return '<section class="q' + (bad ? " bad" : "") + '" id="q-' + q.id + '">' +
      '<h3 class="q-title"><span class="qn">' + String(q.id).padStart(2, "0") + "</span>" +
      esc(q.title) + (q.multi ? "<small>可多选</small>" : "") + "</h3>" +
      (q.note ? '<p class="q-note' + (q.caution ? " warn" : "") + '">' + esc(q.note) + "</p>" : "") +
      (q.illustration ? q21Figure() : "") + body + "</section>";
  }

  function applyAnswer(q, i, j) {
    const a = assess.answers;
    if (q.matrix) {
      let arr = Array.isArray(a[q.id]) ? a[q.id].slice() : [];
      while (arr.length < q.matrix.length) arr.push(null);
      arr[j] = i;
      a[q.id] = arr;
    } else if (q.multi) {
      let arr = Array.isArray(a[q.id]) ? a[q.id].slice() : [];
      const none = q.options.length - 1;
      if (i === none) {
        arr = arr.indexOf(none) >= 0 ? [] : [none];
      } else {
        const k = arr.indexOf(i);
        if (k >= 0) arr.splice(k, 1); else arr.push(i);
        const nk = arr.indexOf(none);
        if (nk >= 0) arr.splice(nk, 1);
        arr.sort(function (x, y) { return x - y; });
      }
      a[q.id] = arr;
    } else {
      a[q.id] = i;
    }
    assess.errors = assess.errors.filter(function (x) { return x !== q.id; });
    saveDraft();
    renderAssessment();
  }

  function renderAssessment() {
    const box = $("#assessBody");
    if (!box || !assess) return;
    const groups = QUES.groups;
    if (!groups.length) { box.innerHTML = '<p class="muted">问卷未能加载。</p>'; return; }

    const visible = QUES.questions.filter(function (q) { return !q.when || q.when(assess.answers); });
    const missing = QUES.missingAnswers(assess.answers);
    const done = visible.length - missing.length;
    const g = groups[assess.group] || groups[0];
    const isLast = assess.group === groups.length - 1;

    const steps = groups.map(function (gr, i) {
      const [s, e] = gr.range;
      const groupDone = !missing.some(function (id) { return id >= s && id <= e; });
      return '<li><button type="button" class="step' + (i === assess.group ? " on" : "") +
        (groupDone ? " done" : "") + '" data-act="go-group" data-g="' + i + '">' +
        '<span class="step-no">' + (groupDone ? "&#10003;" : (i + 1)) + "</span>" + esc(gr.short) + "</button></li>";
    }).join("");

    box.innerHTML =
      '<div class="assess-layout">' +
        '<aside class="assess-side">' +
          '<ol class="steps">' + steps + "</ol>" +
          '<div class="prog"><span style="width:' + Math.round(done / Math.max(1, visible.length) * 100) + '%"></span></div>' +
          '<p class="assess-note">已完成 ' + done + " / " + visible.length + " 题<br>选择后自动保存草稿。<br><br>" +
          "这是一份辅助筛查问卷，结果不能替代专业医疗诊断。<br><br>" +
          "第 21 题为必答自测题，附有姿势图与步骤说明。出现明显疼痛即停止，按实际感受作答。</p>" +
        "</aside>" +
        '<section class="card assess-card">' +
          '<div class="eyebrow">STEP ' + String(assess.group + 1).padStart(2, "0") + " / 04</div>" +
          "<h2>" + esc(g.title) + "</h2>" +
          '<p class="muted">' + esc(g.subtitle) + "</p>" +
          (assess.errors.length
            ? '<div class="form-error" role="alert">' +
                (assess.errors.indexOf(21) >= 0
                  ? "第 21 题为必答题，请参照图示并按实际感受选择后再继续。"
                  : "请补全标记的题目" + (isLast ? "后再提交。" : "后继续。")) +
              "</div>"
            : "") +
          visible.filter(function (q) { return q.id >= g.range[0] && q.id <= g.range[1]; })
            .map(questionHTML).join("") +
          '<div class="q-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="prev-group"' +
              (assess.group === 0 ? ' disabled style="visibility:hidden"' : "") + ">上一步</button>" +
            '<span class="q-count">' + (assess.group + 1) + " / " + groups.length + " 组</span>" +
            '<button type="button" class="btn btn-primary" data-act="' + (isLast ? "submit" : "next-group") + '">' +
              (isLast ? "提交并查看结果" : "继续") + "</button>" +
          "</div>" +
        "</section>" +
      "</div>";
  }

  function openAssessment() {
    if (!currentUser) return;
    if (!assess) {
      // 首次打开：若有草稿，直接跳回第一个未完成的组
      const draft = loadDraft();
      assess = { answers: draft, group: firstGroupWithMissing(draft), errors: [] };
    }
    assess.group = Math.min(assess.group, Math.max(0, QUES.groups.length - 1));
    switchView("assessment");
    renderAssessment();
    window.scrollTo(0, 0);
  }

  async function submitAssessment() {
    const r = QUES.evaluate(assess.answers);
    if (!r.complete) {
      assess.errors = r.missing;
      const first = r.missing[0];
      for (let i = 0; i < QUES.groups.length; i++) {
        const g = QUES.groups[i].range;
        if (first >= g[0] && first <= g[1]) { assess.group = i; break; }
      }
      renderAssessment();
      const el = document.getElementById("q-" + first);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      toast(first === 21 ? "第 21 题为必答题，请参照图示并按实际感受选择。" : "请补全标记的题目。", "err");
      return;
    }
    const btn = document.querySelector('#assessBody [data-act="submit"]');
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await sb.rpc("submit_assessment", {
        p_user_id: currentUser.id,
        p_answers: assess.answers,
        p_core_score: r.core,
        p_exposure: r.exposure,
        p_base_risk: r.base,
        p_risk_level: r.risk,
        p_upgraded: r.upgraded,
        p_warnings: r.warnings,
        p_device_uuid: currentDevice || null,
        p_client_tag: "web"
      });
      if (error) throw error;
      latestAssessment = {
        id: data, created_at: new Date().toISOString(), answers: assess.answers,
        core_score: r.core, exposure: r.exposure, base_risk: r.base,
        risk_level: r.risk, upgraded: r.upgraded, warnings: r.warnings
      };
      try { localStorage.removeItem(draftKey()); } catch (_) {}
      assess = { answers: {}, group: 0, errors: [] };
      toast("评估已提交，结果已保存。", "ok");
      switchView("dashboard");
      renderAssessSummary();
      window.scrollTo(0, 0);
    } catch (e) {
      toast("提交失败：" + (e.message || e), "err");
      if (btn) btn.disabled = false;
    }
  }

  // 看板里的评估摘要卡片
  function renderAssessSummary() {
    const box = $("#assessSummary");
    if (!box) return;
    const a = latestAssessment;
    if (!a) {
      box.innerHTML = '<div class="assess-empty"><p class="muted">还没有评估记录。完成一次手部自评，这里会显示风险等级、症状得分与日常负荷。</p>' +
        '<button type="button" class="btn btn-primary" data-act="go-assess">开始手部评估</button></div>';
      return;
    }
    const names = QUES.riskNames;
    const risk = a.risk_level | 0;
    const warns = Array.isArray(a.warnings) ? a.warnings : [];
    const date = String(a.created_at || "").slice(0, 10);
    box.innerHTML =
      '<div class="assess-res">' +
        '<div class="res-hero lv-' + risk + '">' +
          '<span class="res-lv">' + esc(names[risk] || "") + "</span>" +
          '<p>' + esc(QUES.riskSummary[risk] || "") + "</p>" +
          '<span class="res-date">' + esc(date) + "</span>" +
        "</div>" +
        '<div class="res-scores">' +
          '<div><b>' + (a.core_score | 0) + "</b><small>/ 76</small><span>症状与功能</span></div>" +
          '<div><b>' + (a.exposure | 0) + "</b><small>/ 16</small><span>日常负荷</span></div>" +
          '<div><b>' + esc(names[a.base_risk | 0] || "") + "</b><small>基准</small><span>得分等级</span></div>" +
        "</div>" +
        (warns.length ? '<ul class="res-warn">' + warns.map(function (w) {
          return "<li>" + esc(w) + "</li>";
        }).join("") + "</ul>" : "") +
        '<div class="res-foot"><span class="muted">风险等级依据问卷评分规则生成，不代表疾病确诊。</span>' +
          '<button type="button" class="btn btn-ghost" data-act="go-assess">重新评估</button></div>' +
      "</div>";
  }

  async function loadLatestAssessment() {
    if (!currentUser || !sb) return;
    try {
      const { data, error } = await sb.rpc("get_latest_assessment", { p_user_id: currentUser.id });
      if (error) throw error;
      latestAssessment = (data && data[0]) || null;
    } catch (e) {
      latestAssessment = null;
    }
    renderAssessSummary();
  }

  // ---------- 视图切换 ----------
  function switchView(name) {
    ["dashboard", "assessment", "bind", "login"].forEach(function (v) {
      const el = $("#view-" + v);
      if (el) el.hidden = v !== name;
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
    renderAssessSummary();
    loadDevices().then(function () { loadDashboard(); });
    loadLatestAssessment();
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
      // 清空内存中的问卷状态与评估结果，避免换账号后串用上一个人的数据
      assess = null;
      latestAssessment = null;
      currentDevice = null;
      $("#topbar").hidden = true;
      if ($("#assessBody")) $("#assessBody").innerHTML = "";
      if ($("#assessSummary")) $("#assessSummary").innerHTML = "";
      switchView("login");
    });

    document.querySelectorAll(".nav-link").forEach(function (b) {
      b.addEventListener("click", function () {
        switchView(b.dataset.view);
        if (b.dataset.view === "bind") loadDevices();
        if (b.dataset.view === "dashboard") { loadDashboard(); loadLatestAssessment(); }
        if (b.dataset.view === "assessment") openAssessment();
      });
    });

    // 问卷：选项点击、分步切换、提交（事件委托，重绘后仍生效）
    $("#assessBody").addEventListener("click", function (e) {
      const opt = e.target.closest("[data-q]");
      if (!opt || !assess) return;
      const id = Number(opt.dataset.q);
      const q = QUES.questions.filter(function (x) { return x.id === id; })[0];
      if (!q) return;
      applyAnswer(q, Number(opt.dataset.i), Number(opt.dataset.j));
    });

    document.addEventListener("click", function (e) {
      const t = e.target.closest("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "go-assess") { openAssessment(); return; }
      if (act === "go-group") { assess.group = Number(t.dataset.g); assess.errors = []; renderAssessment(); window.scrollTo(0, 0); return; }
      if (act === "prev-group") { assess.group = Math.max(0, assess.group - 1); assess.errors = []; renderAssessment(); window.scrollTo(0, 0); return; }
      if (act === "next-group") {
        const g = QUES.groups[assess.group];
        assess.errors = QUES.missingAnswers(assess.answers).filter(function (id) {
          return id >= g.range[0] && id <= g.range[1];
        });
        if (assess.errors.length) {
          renderAssessment();
          const el = document.getElementById("q-" + assess.errors[0]);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          toast(assess.errors.indexOf(21) >= 0
            ? "第 21 题为必答题，请参照图示并按实际感受选择。"
            : "请完成本组问题后继续。", "err");
        } else {
          assess.group = Math.min(QUES.groups.length - 1, assess.group + 1);
          renderAssessment();
          window.scrollTo(0, 0);
        }
        return;
      }
      if (act === "submit") { submitAssessment(); }
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
    initTooltip();

    // 恢复会话
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (_) {}
    if (saved) enterApp({ id: saved });
    else switchView("login");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();