/* ==========================================================================
   手护 · 手部重复性劳损自评问卷 — 题库与评分规则
   --------------------------------------------------------------------------
   题库与算分逻辑与「舒腕知护」桌面版一致（23 题 / 4 组）：
     · 第 12–21 题（10 项）+ 第 22 题（9 个子项）= 症状与功能得分，0–76 分
     · 第 7–11 题 = 日常负荷得分，0–16 分
     · 基准等级：≤38 低风险，39–57 中风险，≥58 高风险
     · 负荷 ≥8 分时风险等级上调一级（最高高风险）
   本文件为普通脚本（非 module），暴露 window.HG_QUES。
   ========================================================================== */

(function () {
  "use strict";

  // 「程度」五级量表，多题共用
  const severity = ["无", "轻微", "中等", "严重", "非常严重"];

  // ---------- 分组 ----------
  const groups = [
    { title: "认识你的双手", subtitle: "从一些基本信息开始，让关怀更适合你。", range: [1, 6], short: "基本信息" },
    { title: "了解日常用手习惯", subtitle: "工作之外，家务与兴趣中的用手也值得关注。", range: [7, 11], short: "日常负荷" },
    { title: "听听身体的感受", subtitle: "根据实际感受选择，不需要勉强完成任何动作。", range: [12, 21], short: "症状感受" },
    { title: "看看日常活动的变化", subtitle: "请回顾过去一周的实际情况，完成最后一组。", range: [22, 23], short: "日常功能" }
  ];

  // ---------- 题目 ----------
  const questions = [
    { id: 1, title: "性别", options: ["男", "女"] },
    { id: 2, title: "请问您是否处于以下时期？", options: ["孕期", "产后半年内", "绝经期", "以上均不是"], when: (a) => a[1] === 1 },
    { id: 3, title: "年龄", options: ["＜40岁", "40–60岁", "＞60岁"] },
    { id: 4, title: "是否曾被诊断以下疾病？", multi: true, options: ["糖尿病", "甲状腺功能减退", "类风湿关节炎", "以上均无"] },
    { id: 5, title: "您的惯用手为", options: ["右手", "左手", "双手均衡"] },
    { id: 6, title: "手部不适主要出现在哪一侧？", options: ["左手为主", "右手为主", "双手都有", "双手均无不适"] },
    { id: 7, title: "工作或日常活动中，是否涉及以下手部操作？", multi: true, options: ["重复性动作（如持续点击鼠标、按压、捏取）", "用力抓握／扭转／搬抬重物", "精细手部操作（如书写、装配小零件、缝纫）", "使用振动工具（如电钻、电锯、冲击钻）", "以上均无"] },
    { id: 8, title: "上述手部操作，平均每天累计时长大约为？", options: ["无此类操作", "＜1小时", "1–3小时", "3–5小时", "＞5小时"] },
    { id: 9, title: "平均每天做家务的时间大约为？", options: ["＜1小时", "1–2小时", "2–4小时", "4–6小时", "＞6小时"] },
    { id: 10, title: "家务中是否有反复用力用手的动作？", note: "例如拧拖把、搓洗衣物、切硬质食物。", options: ["从不", "偶尔", "经常", "持续", "几乎每次做家务都有"] },
    { id: 11, title: "以下哪些日常习惯或经历符合您的情况？", multi: true, options: ["平均每天使用智能手机／电脑 ≥3小时", "有长期抱婴儿／幼儿的经历（现在或过去）", "有手工、编织、雕刻、绘画、书法、球类、攀岩或健身等爱好", "以上均无"] },
    { id: 12, title: "夜间手或手腕疼痛的程度？", options: severity },
    { id: 13, title: "白天手或手腕疼痛的程度？", options: ["无痛", ...severity.slice(1)] },
    { id: 14, title: "白天每次疼痛发作持续多久？", options: ["无／＜10分钟", "10–30分钟", "31–60分钟", "＞1小时／断续", "持续不断"] },
    { id: 15, title: "手部是否有麻木感、无力感或刺痛感？", options: severity },
    { id: 16, title: "过去两周，夜间麻木／刺痛将您痛醒的频率？", options: ["从未", "1次", "2–3次", "4–5次", "＞5次"] },
    { id: 17, title: "手指弯曲后伸直时，是否有卡住感或弹响？", options: ["无", "轻微", "中等", "严重", "需要用手辅助才可伸直"] },
    { id: 18, title: "早晨醒来时手指是否僵硬或活动不灵活？", options: ["无", "轻微，＜5分钟", "中等，5–15分钟", "严重，15–30分钟", "非常严重，＞30分钟"] },
    { id: 19, title: "用拇指和食指捏物时，拇指侧手腕疼痛的程度？", note: "例如捏针、拧钥匙。", options: ["无", "轻微", "中等", "严重", "非常严重，无法捏物"] },
    { id: 20, title: "转动门把手或拧毛巾时，手腕拇指侧疼痛是否加重？", options: ["不加重", "轻微加重", "中等加重", "严重加重", "完全无法完成上述动作"] },
    {
      id: 21,
      title: "以下自测动作中，手腕拇指侧的感受如何？",
      note: "本题必答。参照下方图示，按实际感受选择；出现明显疼痛即停止，不要反复测试。若确实无法完成动作，请选择“完全无法完成上述动作”。",
      options: ["无痛", "轻微拉扯感", "明显疼痛", "剧烈疼痛", "完全无法完成上述动作"],
      caution: true,
      illustration: true
    },
    {
      id: 22,
      title: "过去一周，完成以下活动的困难程度？",
      matrix: [
        "开一个紧的或新的罐子／瓶子",
        "做需要较大力气的手工活（如拧螺丝、锤钉）",
        "提一个较重的购物袋或公文包",
        "使用刀具切食物",
        "需要手臂上举的活动（如挂衣服、取高处物品）",
        "参与娱乐活动（如体育运动、弹奏乐器、做手工）",
        "用笔或铅笔写字",
        "扣上或解开纽扣",
        "从口袋或钱包中取出硬币"
      ],
      options: ["无困难", "轻微困难", "中等困难", "非常困难", "无法完成"]
    },
    { id: 23, title: "过去一周，手／腕疼痛或麻木对工作或日常生活的影响程度？", options: ["完全不影响", "轻微影响", "中度影响", "很大影响", "完全无法参与社交活动"], note: "此题仅作补充描述，不计入风险得分。" }
  ];

  // ---------- 校验：返回未作答 / 作答非法的题号 ----------
  function missingAnswers(a) {
    const missing = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (q.when && !q.when(a)) continue;
      const v = a[q.id];
      if (q.matrix) {
        if (!Array.isArray(v) || v.length !== q.matrix.length ||
            v.some((x) => !Number.isInteger(x) || x < 0 || x > 4)) missing.push(q.id);
      } else if (q.multi) {
        if (!Array.isArray(v) || !v.length ||
            v.some((x) => !Number.isInteger(x) || x < 0 || x >= q.options.length) ||
            (v.includes(q.options.length - 1) && v.length > 1)) missing.push(q.id);
      } else if (!Number.isInteger(v) || v < 0 || v >= q.options.length) {
        missing.push(q.id);
      }
    }
    return missing;
  }

  // ---------- 评分 ----------
  // core：第 12–21 题 + 第 22 题 9 个子项，0–76
  // exposure：第 7 题选择数 + 第 8/9/10 题权重 + 第 11 题选择数，0–16
  function evaluate(a) {
    const missing = missingAnswers(a);
    if (missing.length) return { complete: false, missing };

    let core = 0;
    for (let i = 0; i < 10; i++) core += a[i + 12];
    core += a[22].reduce((s, v) => s + v, 0);

    const count = (id, none) => (a[id].includes(none) ? 0 : a[id].length);
    const w = [0, 0, 1, 2, 3];
    const exposure =
      count(7, 4) + w[a[8]] + w[a[9]] + w[a[10]] + count(11, 3);

    const base = core <= 38 ? 0 : core <= 57 ? 1 : 2;
    const risk = Math.min(2, base + (exposure >= 8 ? 1 : 0));

    const warnings = [];
    if (a[1] === 1 && (a[2] !== 3 || a[3] === 1)) {
      warnings.push("根据问卷背景信息，您属于需要额外关注手部健康的人群。");
    }
    if (a[4].includes(0) || a[4].includes(2)) {
      warnings.push("您的基础疾病可能增加手部疾病风险。");
    }
    if (exposure >= 4 && exposure <= 7) {
      warnings.push("您日常手部负荷较重。");
    }

    return { complete: true, core, exposure, base, risk, warnings, upgraded: risk > base };
  }

  // ---------- 文案 ----------
  const riskNames = ["低风险", "中风险", "高风险"];
  const riskSummary = [
    "按本问卷规则，当前综合风险为低风险。可结合具体症状与功能感受关注手部状态。",
    "建议减少连续手部操作时间，留意症状与日常活动的变化。",
    "建议尽快咨询专科医生，结合专业检查进一步评估。"
  ];

  window.HG_QUES = {
    groups: groups,
    questions: questions,
    missingAnswers: missingAnswers,
    evaluate: evaluate,
    riskNames: riskNames,
    riskSummary: riskSummary
  };
})();
