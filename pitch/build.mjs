// Ghost-Pea 共振镜头 · 黑客松路演 PPT 生成脚本
// 风格：iPhone 发布会（近黑底 / 超大字 / 单一琥珀金 accent / 同心圆母题）
import pptxgen from "pptxgenjs";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "Ghost-Pea";
pres.title = "共振镜头 · 让镜头听见此刻";

// ---------- 设计系统 ----------
const W = 13.33, H = 7.5;
const BG = "0A0A0E";      // 近黑（带一点蓝紫底调）
const TEXT = "F5F5F7";    // 苹果白
const MUTED = "9E9EA6";   // 次要灰
const ACCENT = "E8A33D";  // 琥珀金（演唱会灯光 / 暗房感）
const HAIRLINE = "2A2A32";
const BAND1 = "15151C", BAND2 = "1D1D26", BAND3 = "262630";
const FONT = "微软雅黑";

const T = (text, o) => [text, { fontFace: FONT, margin: 0, ...o }];
const kicker = (slide, label) =>
  slide.addText(...T(label, { x: 0.8, y: 0.5, w: 6, h: 0.3, fontSize: 12, color: MUTED, charSpacing: 3 }));

// 同心圆母题：共振声波的隐喻，描边极淡，压在文字后面
function rings(slide, cx, cy) {
  for (const [d, tr] of [[6.4, 78], [4.5, 84], [2.7, 90]]) {
    slide.addShape(pres.shapes.OVAL, {
      x: cx - d / 2, y: cy - d / 2, w: d, h: d,
      fill: { type: "none" }, line: { color: ACCENT, width: 1, transparency: tr },
    });
  }
}

const newSlide = () => {
  const s = pres.addSlide();
  s.background = { color: BG };
  return s;
};

// ---------- P1 封面 ----------
{
  const s = newSlide();
  rings(s, W / 2, 3.55);
  s.addText(...T("影石白日方舟黑客松 · 赛道一 · 南京 2026", {
    x: 0, y: 0.55, w: W, h: 0.3, fontSize: 12, color: MUTED, align: "center", charSpacing: 3,
  }));
  s.addText(...T("让镜头听见此刻", {
    x: 0, y: 2.72, w: W, h: 1.1, fontSize: 60, bold: true, color: TEXT, align: "center",
  }));
  s.addText(...T("Ghost-Pea 共振镜头 · 声音实时驱动的动态成像系统", {
    x: 0, y: 4.0, w: W, h: 0.4, fontSize: 17, color: MUTED, align: "center",
  }));
  s.addText(...T("张智瑞 · 李佳玥", {
    x: 0, y: 6.7, w: W, h: 0.3, fontSize: 13, color: MUTED, align: "center",
  }));
}

// ---------- P2 问题 ----------
{
  const s = newSlide();
  kicker(s, "01 — 问题");
  s.addText(...T("滤镜是死的。", { x: 1.0, y: 2.05, w: 11.3, h: 1.0, fontSize: 54, bold: true, color: TEXT }));
  s.addText(...T("现场是活的。", { x: 1.0, y: 3.05, w: 11.3, h: 1.0, fontSize: 54, bold: true, color: ACCENT }));
  s.addText(...T("选定一个预设，整段视频一个风格。", { x: 1.0, y: 4.75, w: 11.3, h: 0.4, fontSize: 17, color: MUTED }));
  s.addText(...T("等坐进后期软件，氛围已经凉了。", { x: 1.0, y: 5.2, w: 11.3, h: 0.4, fontSize: 17, color: MUTED }));
}

// ---------- P3 方案：三个「不是」 ----------
{
  const s = newSlide();
  kicker(s, "02 — 方案");
  s.addText(...T("共振镜头 —— 由现场声音实时驱动的动态成像系统。", {
    x: 1.0, y: 1.15, w: 11.3, h: 0.5, fontSize: 20, color: TEXT,
  }));
  const rows = [
    ["不是音频可视化。", "声音控制的是影调、光晕、颗粒 —— 是成像参数。"],
    ["不是后期处理。", "拍摄的那一刻，就看到最终画面。"],
    ["不替代物理滤镜。", "而是让参数连续、自动、可编程。"],
  ];
  rows.forEach(([head, sub], i) => {
    const y = 2.35 + i * 1.5;
    if (i > 0) s.addShape(pres.shapes.LINE, { x: 1.0, y: y - 0.25, w: 11.33, h: 0, line: { color: HAIRLINE, width: 1 } });
    s.addText(...T(head, { x: 1.0, y, w: 4.6, h: 0.9, fontSize: 30, bold: true, color: TEXT, valign: "middle" }));
    s.addText(...T(sub, { x: 5.9, y, w: 6.4, h: 0.9, fontSize: 16, color: MUTED, valign: "middle" }));
  });
}

// ---------- P4 原理：四步 ----------
{
  const s = newSlide();
  kicker(s, "03 — 原理");
  s.addText(...T("声音到画面，四步。", { x: 1.0, y: 1.0, w: 11.3, h: 0.8, fontSize: 40, bold: true, color: TEXT }));
  const steps = [
    ["1", "采集", "WASAPI 系统音频回环"],
    ["2", "特征", "60Hz · 响度 频段 打击点 重心"],
    ["3", "编排", "平滑 · 限速 · 静音回落"],
    ["4", "成像", "WebGL2 滤镜链 · 3D LUT"],
  ];
  steps.forEach(([num, name, sub], i) => {
    const x = 0.8 + i * 3.02;
    s.addText(...T(num, { x, y: 2.55, w: 2.7, h: 0.6, fontSize: 28, bold: true, color: ACCENT }));
    s.addText(...T(name, { x, y: 3.25, w: 2.7, h: 0.5, fontSize: 22, bold: true, color: TEXT }));
    s.addText(...T(sub, { x, y: 3.85, w: 2.7, h: 0.8, fontSize: 13, color: MUTED }));
    if (i < 3) s.addText(...T("→", { x: x + 2.62, y: 3.2, w: 0.5, h: 0.5, fontSize: 22, color: MUTED, align: "center" }));
  });
  s.addText(...T("视频帧全程留在 GPU，不经过 IPC。", {
    x: 0, y: 6.1, w: W, h: 0.4, fontSize: 16, color: MUTED, align: "center",
  }));
}

// ---------- P5 Demo 引导页 ----------
{
  const s = newSlide();
  s.addText(...T("让镜头听一首歌。", { x: 0, y: 1.55, w: W, h: 0.9, fontSize: 46, bold: true, color: TEXT, align: "center" }));
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 2.67, y: 2.75, w: 8, h: 3.3, rectRadius: 0.08, fill: { color: "101016" }, line: { color: HAIRLINE, width: 1 },
  });
  s.addText(...T("现 场 演 示", { x: 2.67, y: 3.95, w: 8, h: 0.5, fontSize: 20, color: MUTED, align: "center", charSpacing: 6 }));
  s.addText(...T("（路演前替换为实拍对比截图，或现场实操）", {
    x: 2.67, y: 4.5, w: 8, h: 0.35, fontSize: 12, color: MUTED, align: "center",
  }));
  s.addText(...T("A/B 原图对比 · 三主题切换 · 静音回落 · AI 氛围模式", {
    x: 0, y: 6.45, w: W, h: 0.4, fontSize: 14, color: MUTED, align: "center",
  }));
}

// ---------- P6 技术：三层时间尺度 ----------
{
  const s = newSlide();
  kicker(s, "04 — 技术");
  s.addText(...T("三层时间尺度。", { x: 1.0, y: 1.0, w: 11.3, h: 0.8, fontSize: 40, bold: true, color: TEXT }));
  const bands = [
    ["60 Hz", "快速 DSP", "管即时响应 —— 响度、频段能量、打击点", BAND1],
    ["2–10 Hz", "中速趋势", "管动态幅度 —— 平滑、限速、回落", BAND2],
    ["0.5–2 Hz", "AI 氛围分类", "只决定氛围走向，不进低延迟链路", BAND3],
  ];
  bands.forEach(([hz, name, sub, fill], i) => {
    const y = 2.15 + i * 1.35;
    s.addShape(pres.shapes.RECTANGLE, { x: 1.0, y, w: 11.33, h: 1.1, fill: { color: fill }, line: { type: "none" } });
    s.addText(...T(hz, { x: 1.5, y, w: 2.6, h: 1.1, fontSize: 28, bold: true, color: ACCENT, valign: "middle" }));
    s.addText(...T(name, { x: 4.3, y, w: 2.8, h: 1.1, fontSize: 19, bold: true, color: TEXT, valign: "middle" }));
    s.addText(...T(sub, { x: 7.3, y, w: 4.8, h: 1.1, fontSize: 14, color: MUTED, valign: "middle" }));
  });
  s.addText(...T("快的保响应，慢的保稳定；AI 失败，基础链路照常工作。", {
    x: 0, y: 6.35, w: W, h: 0.4, fontSize: 15, color: MUTED, align: "center",
  }));
}

// ---------- P7 大数字 ----------
{
  const s = newSlide();
  kicker(s, "04 — 技术");
  const stats = [
    ["60", "Hz · 音频特征更新", "Rust 端实时 DSP"],
    ["~100", "ms · 声音到画面", "设计目标，本地链路预算"],
    ["60", "FPS · 实时渲染", "WebGL2，帧不过 IPC"],
    ["0", "云端依赖", "推理全部本地完成"],
  ];
  stats.forEach(([num, label, sub], i) => {
    const x = 0.8 + i * 3.02;
    s.addText(...T(num, { x, y: 2.7, w: 2.7, h: 0.9, fontSize: 48, bold: true, color: ACCENT }));
    s.addText(...T(label, { x, y: 3.75, w: 2.7, h: 0.4, fontSize: 16, bold: true, color: TEXT }));
    s.addText(...T(sub, { x, y: 4.2, w: 2.7, h: 0.6, fontSize: 12, color: MUTED }));
  });
  s.addText(...T("延迟与帧率为设计目标与本地链路预算，详见技术文档。", {
    x: 0, y: 6.5, w: W, h: 0.3, fontSize: 11, color: MUTED, align: "center",
  }));
}

// ---------- P8 AI：增强而非依赖 ----------
{
  const s = newSlide();
  kicker(s, "05 — AI");
  s.addText(...T("AI 是增强，不是依赖。", {
    x: 0, y: 1.35, w: W, h: 0.9, fontSize: 42, bold: true, color: TEXT, align: "center",
  }));
  s.addShape(pres.shapes.LINE, { x: W / 2, y: 2.9, w: 0, h: 2.6, line: { color: HAIRLINE, width: 1 } });
  s.addText(...T("本地推理", { x: 1.3, y: 2.9, w: 5.0, h: 0.4, fontSize: 16, bold: true, color: ACCENT }));
  s.addText(...T("Essentia.js + MusiCNN 情绪模型", { x: 1.3, y: 3.45, w: 5.0, h: 0.4, fontSize: 15, color: TEXT }));
  s.addText(...T("Web Worker 中运行，不占渲染线程", { x: 1.3, y: 3.9, w: 5.0, h: 0.4, fontSize: 15, color: TEXT }));
  s.addText(...T("四种氛围：快乐 · 悲伤 · 放松 · 激进", { x: 1.3, y: 4.35, w: 5.0, h: 0.4, fontSize: 15, color: TEXT }));
  s.addText(...T("失败自动降级", { x: 7.1, y: 2.9, w: 5.0, h: 0.4, fontSize: 16, bold: true, color: ACCENT }));
  s.addText(...T("模型未就绪 → 占位推理", { x: 7.1, y: 3.45, w: 5.0, h: 0.4, fontSize: 15, color: TEXT }));
  s.addText(...T("Worker 异常 → 降级运行", { x: 7.1, y: 3.9, w: 5.0, h: 0.4, fontSize: 15, color: TEXT }));
  s.addText(...T("静音 → 自动回落基础滤镜", { x: 7.1, y: 4.35, w: 5.0, h: 0.4, fontSize: 15, color: TEXT }));
  s.addText(...T("氛围走向由 AI 决定，画面稳定由工程保证。", {
    x: 0, y: 6.1, w: W, h: 0.4, fontSize: 15, color: MUTED, align: "center",
  }));
}

// ---------- P9 落地 ----------
{
  const s = newSlide();
  kicker(s, "06 — 落地");
  s.addText(...T("已在 Ace Pro2 + Link 上验证。", { x: 1.0, y: 1.1, w: 11.3, h: 0.8, fontSize: 38, bold: true, color: TEXT }));
  const scenes = [
    ["演唱会", "灯海随鼓点呼吸"],
    ["骑行途中", "风与速度改变影调"],
    ["夜晚独处", "一首歌一种氛围"],
  ];
  scenes.forEach(([name, sub], i) => {
    const x = 0.8 + i * 4.1;
    s.addText(...T(name, { x, y: 2.9, w: 3.8, h: 0.6, fontSize: 26, bold: true, color: TEXT }));
    s.addText(...T(sub, { x, y: 3.6, w: 3.8, h: 0.4, fontSize: 14, color: MUTED }));
  });
  s.addText(...T("声音条件化成像，可下沉至相机 ISP / GPU，或伴侣 App。", {
    x: 0, y: 6.0, w: W, h: 0.5, fontSize: 18, color: TEXT, align: "center",
  }));
}

// ---------- P10 结尾 ----------
{
  const s = newSlide();
  rings(s, W / 2, 3.55);
  s.addText(...T("让镜头听见此刻。", {
    x: 0, y: 2.72, w: W, h: 1.0, fontSize: 54, bold: true, color: TEXT, align: "center",
  }));
  s.addText(...T("下一步 —— Memory Mode 氛围记录 · 参数录制回放 · 端侧下沉", {
    x: 0, y: 4.15, w: W, h: 0.4, fontSize: 15, color: MUTED, align: "center",
  }));
  s.addText(...T("Ghost-Pea 共振镜头 · 张智瑞 · 李佳玥", {
    x: 0, y: 6.7, w: W, h: 0.3, fontSize: 13, color: MUTED, align: "center",
  }));
}

await pres.writeFile({ fileName: "Ghost-Pea-共振镜头-路演.pptx" });
console.log("done");
