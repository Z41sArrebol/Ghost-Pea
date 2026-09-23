import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Input,
  Message,
  Modal,
  Radio,
  Select,
  Slider,
  Space,
  Tabs,
  Tag,
  Typography,
} from "@arco-design/web-react";
import { IconFullscreen, IconFullscreenExit, IconLiveBroadcast, IconMoon, IconSun } from "@arco-design/web-react/icon";
import { AiFilterController, type FilterMode } from "./ai/AiFilterController";
import { DEFAULT_VALENCE_SENSITIVITY } from "./ai/moodCalibration";
import { getActiveAiMood, useAiMood } from "./ai/useAiMood";
import { AUDIO_STALE_MS, useAudioFeatures } from "./audio/useAudioFeatures";
import { ParamSliders } from "./components/ParamSliders";
import { RmsWaveform } from "./components/RmsWaveform";
import { FilterRenderer, type FitMode, type UniformValues } from "./gl/FilterRenderer";
import { ParameterOrchestrator, rmsToVisualLevel } from "./params/orchestrator";
import { THEME_PRESETS } from "./params/presets";
import { DEFAULT_PARAMS, parseParams, type ParamValues } from "./params/schema";
import { useCamera, type CameraConfig } from "./useCamera";

const STATUS_UPDATE_MS = 250;

type FunctionKey = "filter" | "mapping" | "orchestrator" | "camera" | "ai" | "presets";

const TAB_ITEMS: { key: FunctionKey; label: string }[] = [
  { key: "filter", label: "滤镜" },
  { key: "mapping", label: "映射" },
  { key: "orchestrator", label: "编排" },
  { key: "camera", label: "相机" },
  { key: "ai", label: "AI" },
  { key: "presets", label: "预设" },
];

const LIVE_HINT_MS = 3500;

// 直播模式全屏：优先走 Tauri 窗口 API，非 Tauri 环境（浏览器预览）回退到 Fullscreen API
async function applyWindowFullscreen(next: boolean) {
  const inTauri = typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
  if (inTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(next);
      return;
    } catch {
      // 权限未授予或调用失败：继续尝试浏览器全屏
    }
  }
  try {
    if (next) {
      if (!document.fullscreenElement && typeof document.documentElement.requestFullscreen === "function") {
        await document.documentElement.requestFullscreen();
      }
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    // 全屏被拒绝（缺少用户手势等）时忽略：直播布局依然生效
  }
}

function DemoPage({ themeMode, onToggleTheme }: { themeMode: "dark" | "light"; onToggleTheme: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraConfig, setCameraConfig] = useState<CameraConfig>({ deviceId: "", resolution: "auto", frameRate: 0 });
  const { cameras, error: cameraError, busy: cameraBusy, retry: retryCamera } = useCamera(videoRef, cameraConfig);
  const [glError, setGlError] = useState("");
  const [glWarning, setGlWarning] = useState("");
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [bypass, setBypass] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>("cover");
  const [filterMode, setFilterMode] = useState<FilterMode>("default");
  const [params, setParams] = useState<ParamValues>({ ...DEFAULT_PARAMS });
  const [activeFn, setActiveFn] = useState<FunctionKey>("filter");
  const [frameStats, setFrameStats] = useState({ render: 0, video: 0, p95: 0 });
  const [meter, setMeter] = useState({ rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0.5 });
  const [valenceSensitivity, setValenceSensitivity] = useState(DEFAULT_VALENCE_SENSITIVITY);
  const [liveMode, setLiveMode] = useState(false);
  const [liveHintVisible, setLiveHintVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const liveHintTimer = useRef<number | null>(null);
  const liveHintVisibleRef = useRef(false);
  liveHintVisibleRef.current = liveHintVisible;
  const isFullscreenRef = useRef(false);
  isFullscreenRef.current = isFullscreen;

  const { featuresRef, lastReceivedAtRef, running, source, status, busy: audioBusy, error: audioError, stale: audioStale, start, stop } = useAudioFeatures();
  const {
    mood,
    moodLabel,
    moodState,
    dominantMood,
    workerReady,
    stale,
    status: aiStatus,
    error: aiError,
    selfTest,
  } = useAiMood(valenceSensitivity);

  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;
  const fitModeRef = useRef(fitMode);
  fitModeRef.current = fitMode;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const aiControlRef = useRef({ filterMode, mood, status: aiStatus, running });
  aiControlRef.current = { filterMode, mood, status: aiStatus, running };
  const rmsLevelRef = useRef(0);
  const aiDriving = running && !audioStale && !featuresRef.current.silence
    && rmsToVisualLevel(featuresRef.current.rms) > 0
    && getActiveAiMood(mood, aiStatus, performance.now()) !== null;

  const setParam = useCallback((key: string, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 直播模式只负责隐藏界面（窗口尺寸不变，方便同机操作 OBS）；退出时一并退出全屏
  const setLive = useCallback((next: boolean) => {
    setLiveMode(next);
    if (!next) {
      setIsFullscreen(false);
      void applyWindowFullscreen(false);
    }
  }, []);

  const showLiveHint = useCallback(() => {
    setLiveHintVisible(true);
    if (liveHintTimer.current !== null) window.clearTimeout(liveHintTimer.current);
    liveHintTimer.current = window.setTimeout(() => setLiveHintVisible(false), LIVE_HINT_MS);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const next = !isFullscreenRef.current;
    setIsFullscreen(next);
    void applyWindowFullscreen(next);
    showLiveHint();
  }, [showLiveHint]);

  // 直播模式：Esc 退出；F 切换全屏；鼠标滑动时短暂呼出提示
  useEffect(() => {
    if (!liveMode) return;
    showLiveHint();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLive(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (!typing && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        toggleFullscreen();
      }
    };
    const onMouseMove = () => {
      if (!liveHintVisibleRef.current) showLiveHint();
    };
    const onFullscreenChange = () => {
      // 用户用 F11 / 系统方式切换全屏时同步按钮状态（不据此退出直播模式）
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousemove", onMouseMove);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [liveMode, setLive, showLiveHint, toggleFullscreen]);

  useEffect(() => () => {
    if (liveHintTimer.current !== null) window.clearTimeout(liveHintTimer.current);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: FilterRenderer | null = null;
    setGlError("");
    setGlWarning("");
    try {
      renderer = new FilterRenderer(canvas);
    } catch (error) {
      setGlError(error instanceof Error ? error.message : String(error));
    }
    const onLost = (event: Event) => {
      event.preventDefault();
      renderer?.dispose();
      renderer = null;
      setGlError("显卡上下文已中断，正在等待恢复；恢复后会自动重建预览");
    };
    const onRestored = () => setPreviewAttempt((value) => value + 1);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    const orchestrator = new ParameterOrchestrator(paramsRef.current);
    const aiController = new AiFilterController();
    let raf = 0;
    let last = performance.now();
    let lastStatus = last;
    let statsStart = last;
    let drawn = 0;
    let previousVideoFrames = 0;
    let lastDrawAt = 0;
    const intervals: number[] = [];

    const frame = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const receivedAt = lastReceivedAtRef.current;
      const available = aiControlRef.current.running && receivedAt !== null && now - receivedAt <= AUDIO_STALE_MS;
      const base = orchestrator.update(paramsRef.current, featuresRef.current, available, dt);
      const control = aiControlRef.current;
      const audible = control.running && available && !featuresRef.current.silence
        && rmsToVisualLevel(featuresRef.current.rms) > 0;
      const activeMood = audible ? getActiveAiMood(control.mood, control.status, now) : null;
      const p = aiController.update(base, orchestrator.params, control.filterMode, activeMood, dt);
      rmsLevelRef.current = orchestrator.features.rms;
      if (renderer && videoRef.current) {
        const uniforms: UniformValues = {
          uTime: now / 1000,
          uBypass: bypassRef.current ? 1 : 0,
          uContrast: p.contrast,
          uBrightness: p.brightness,
          uTemperature: p.temperature,
          uShadowCool: p.shadowCool,
          uHighlightThr: p.highlightThr,
          uVignette: p.vignette,
          uGrain: p.grain,
          uBloom: orchestrator.params.bloomEnabled ? p.bloom : 0,
          uBloomWarm: orchestrator.params.bloomEnabled ? p.bloomWarm : 0,
          uLookDark: p.lookDark,
          uLookCalm: p.lookCalm,
          uLookBright: p.lookBright,
          uLookHappy: p.lookHappy,
          uLookSad: p.lookSad,
          uLookRelaxed: p.lookRelaxed,
          uLookAggressive: p.lookAggressive,
          uLookBeat: available && !featuresRef.current.silence
            ? orchestrator.params.mapOnsetLook * orchestrator.params.intensity * Math.tanh(orchestrator.features.onset * rmsToVisualLevel(orchestrator.features.rms) / 0.5)
            : 0,
          uBassTint: available && !featuresRef.current.silence
            ? orchestrator.params.mapBassTint * orchestrator.params.intensity * Math.tanh(orchestrator.features.bass * rmsToVisualLevel(orchestrator.features.rms) * 2)
            : 0,
          uZoom: !bypassRef.current && available && orchestrator.params.bassZoomEnabled === 1
            ? 1 + orchestrator.params.mapBassZoom * orchestrator.params.intensity * orchestrator.bassPulse
            : 1,
          uSoftClip: control.filterMode === "ai" ? 1 : 0,
          uSaturation: p.saturation,
          uGammaMid: p.gammaMid,
        };
        try {
          if (renderer.render(videoRef.current, uniforms, fitModeRef.current)) {
            drawn++;
            if (lastDrawAt > 0) {
              intervals.push(now - lastDrawAt);
              if (intervals.length > 120) intervals.shift();
            }
            lastDrawAt = now;
          } else {
            lastDrawAt = 0;
          }
        } catch (error) {
          renderer.dispose();
          renderer = null;
          setGlError(`预览已暂停：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (now - lastStatus >= STATUS_UPDATE_MS) {
        lastStatus = now;
        setMeter({ ...orchestrator.features });
        setGlWarning(renderer?.warning ?? "");
      }
      if (now - statsStart >= 1000) {
        const seconds = (now - statsStart) / 1000;
        const videoFrames = renderer?.videoFrames ?? previousVideoFrames;
        const sorted = [...intervals].sort((a, b) => a - b);
        setFrameStats({
          render: Math.round(drawn / seconds),
          video: Math.round((videoFrames - previousVideoFrames) / seconds),
          p95: drawn ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0) : 0,
        });
        previousVideoFrames = videoFrames;
        drawn = 0;
        statsStart = now;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      renderer?.dispose();
    };
  }, [featuresRef, lastReceivedAtRef, previewAttempt]);

  const exportParams = useCallback(async () => {
    const json = JSON.stringify(params, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      Message.success("参数 JSON 已复制到剪贴板");
    } catch {
      Modal.info({
        title: "当前参数 JSON（手动复制）",
        content: <Input.TextArea rows={10} readOnly value={json} />,
      });
    }
  }, [params]);

  const importParams = useCallback(() => {
    let text = "";
    Modal.confirm({
      title: "导入参数 JSON",
      content: (
        <Input.TextArea
          rows={8}
          placeholder='{"baseContrast": 1.12, ...}'
          onChange={(value) => {
            text = value;
          }}
        />
      ),
      onOk: () => {
        try {
          setParams(parseParams(JSON.parse(text), paramsRef.current));
          Message.success("参数已导入");
        } catch (error) {
          Message.error(`${error instanceof Error ? error.message : "参数无效"}，未做任何修改`);
        }
      },
    });
  }, []);

  const panelContent = () => {
    switch (activeFn) {
      case "filter":
      case "mapping":
      case "orchestrator":
        return <ParamSliders group={activeFn} params={params} onChange={setParam} />;
      case "camera":
        return (
          <Space direction="vertical" size="medium" style={{ width: "100%" }}>
            <div>
              <Typography.Text>分辨率</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 8 }}
                value={cameraConfig.resolution}
                onChange={(resolution) => setCameraConfig((c) => ({ ...c, resolution }))}
                options={[
                  { value: "auto", label: "自动" },
                  { value: "720p", label: "1280 × 720" },
                  { value: "1080p", label: "1920 × 1080" },
                ]}
              />
            </div>
            <div>
              <Typography.Text>帧率</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 8 }}
                value={cameraConfig.frameRate}
                onChange={(frameRate) => setCameraConfig((c) => ({ ...c, frameRate }))}
                options={[
                  { value: 0, label: "自动" },
                  { value: 30, label: "30 FPS" },
                  { value: 60, label: "60 FPS" },
                ]}
              />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              修改后相机会重启视频流。
            </Typography.Text>
          </Space>
        );
      case "ai":
        return (
          <Space direction="vertical" size="medium" style={{ width: "100%" }}>
            <Space wrap>
              <Tag color={workerReady ? "green" : aiStatus.phase === "failed" ? "red" : "orange"}>
                {aiStatus.phase}
              </Tag>
              <Tag color={aiStatus.backendConnected ? "green" : "default"}>
                PCM {aiStatus.backendConnected ? "已连接" : "未连接"}
              </Tag>
              <Tag color={aiStatus.modelReady ? "green" : "orange"}>
                模型 {aiStatus.modelReady ? "就绪" : "占位"}
              </Tag>
              {stale && <Tag color="orange">结果超时</Tag>}
            </Space>

            <div>
              <Typography.Text type="secondary">AI 输出标签</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Tag color={moodLabel === "neutral" ? "orange" : "green"}>
                  {moodLabel}
                </Tag>
                {dominantMood && <Tag style={{ marginLeft: 8 }}>最高候选：{dominantMood}</Tag>}
              </div>
            </div>

            <div>
              <div className="param-head">
                <Typography.Text>快乐 / 悲伤灵敏度</Typography.Text>
                <Typography.Text type="secondary">{valenceSensitivity.toFixed(0)}</Typography.Text>
              </div>
              <Slider
                min={4}
                max={40}
                step={1}
                value={valenceSensitivity}
                onChange={(value) => setValenceSensitivity(Array.isArray(value) ? value[0] : value)}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(88px, auto) minmax(0, 1fr)",
                gap: "8px 16px",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <Typography.Text type="secondary">Stream epoch</Typography.Text>
              <Typography.Text>{mood?.streamEpoch.toString() ?? "-"}</Typography.Text>
              <Typography.Text type="secondary">Sequence</Typography.Text>
              <Typography.Text>{mood?.sequence.toString() ?? "-"}</Typography.Text>
              <Typography.Text type="secondary">领先置信度</Typography.Text>
              <Typography.Text>{mood ? mood.confidence.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Valence</Typography.Text>
              <Typography.Text>{mood ? mood.valence.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Inference</Typography.Text>
              <Typography.Text>{mood ? `${mood.inferenceMs.toFixed(1)} ms` : "-"}</Typography.Text>
              <Typography.Text type="secondary">Happy（转换）</Typography.Text>
              <Typography.Text>{mood ? mood.happy.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Sad（转换）</Typography.Text>
              <Typography.Text>{mood ? mood.sad.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Relaxed（转换）</Typography.Text>
              <Typography.Text>{mood ? mood.relaxed.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Aggressive（转换）</Typography.Text>
              <Typography.Text>{mood ? mood.aggressive.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Happy（原始）</Typography.Text>
              <Typography.Text>{mood ? mood.rawHappy.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Sad（原始）</Typography.Text>
              <Typography.Text>{mood ? mood.rawSad.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Relaxed（原始）</Typography.Text>
              <Typography.Text>{mood ? mood.rawRelaxed.toFixed(4) : "-"}</Typography.Text>
              <Typography.Text type="secondary">Aggressive（原始）</Typography.Text>
              <Typography.Text>{mood ? mood.rawAggressive.toFixed(4) : "-"}</Typography.Text>
            </div>

            {aiError && <Alert type="error" content={aiError} />}
            <Button onClick={selfTest}>重新连接 AI</Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {filterMode === "ai"
                ? "多种情绪共同影响调色、柔光和颗粒，缓慢过渡，不按单个标签切换预设。"
                : "当前为默认模式，AI 仅展示分析结果；切换 AI 模式后参与滤镜控制。"}
            </Typography.Text>
          </Space>
        );
      case "presets":
        return (
          <Space direction="vertical" size="medium" style={{ width: "100%" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              预设只覆盖滤镜与映射参数，编排器和相机配置不受影响。
            </Typography.Text>
            {THEME_PRESETS.map((preset) => (
              <Button
                key={preset.key}
                long
                onClick={() => {
                  setParams((prev) => {
                    const next = { ...prev };
                    for (const [key, value] of Object.entries(preset.values)) {
                      if (value !== undefined) next[key] = value;
                    }
                    return next;
                  });
                  Message.success(`已应用预设：${preset.label}`);
                }}
              >
                {preset.label}
              </Button>
            ))}
            <Divider style={{ margin: "8px 0" }} />
            <Button long onClick={() => setParams({ ...DEFAULT_PARAMS })}>
              重置为默认参数
            </Button>
            <Button long onClick={() => void exportParams()}>
              导出参数 JSON
            </Button>
            <Button long onClick={importParams}>
              导入参数 JSON
            </Button>
          </Space>
        );
    }
  };

  return (
    <div className={`page${liveMode ? " live" : ""}`}>
      <div className="stage">
        <video ref={videoRef} className="hidden-video" playsInline muted />
        <canvas ref={canvasRef} className={`preview${fitMode === "cover" ? " fit-cover" : ""}`} />
        <Select
          className="device-select"
          size="small"
          value={cameraConfig.deviceId}
          onChange={(deviceId) => setCameraConfig((c) => ({ ...c, deviceId }))}
          options={[
            { value: "", label: "默认相机" },
            ...cameras.map((cam, i) => ({ value: cam.deviceId, label: cam.label || `相机 ${i + 1}` })),
          ]}
        />

        <div className="stage-actions">
          <Radio.Group
            type="button"
            size="small"
            value={fitMode}
            onChange={setFitMode}
            options={[
              { label: "铺满", value: "cover" },
              { label: "适应", value: "contain" },
            ]}
          />
          <Button size="small" type="primary" loading={audioBusy} disabled={audioBusy} onClick={() => void (running ? stop() : start())}>
            {running ? "停止音频" : "开始音频"}
          </Button>
          {running && (
            <Tag color={audioStale ? "orange" : source === "tauri" ? "green" : "orange"}>
              {audioStale ? "音频信号中断" : source === "tauri" ? "系统音频" : "模拟信号"}
            </Tag>
          )}
          <Checkbox checked={bypass} onChange={(checked) => setBypass(checked)}>
            A/B 原图
          </Checkbox>
          {(cameraError || glError || glWarning) && (
            <Button size="small" disabled={cameraBusy} onClick={() => {
              if (cameraError) retryCamera();
              setPreviewAttempt((value) => value + 1);
            }}>重试预览</Button>
          )}
          <Button size="small" icon={<IconLiveBroadcast />} onClick={() => setLive(true)}>
            直播模式
          </Button>
        </div>

        <div className="stage-stats">
          <Typography.Text type="secondary">渲染 {frameStats.render} FPS · 视频 {frameStats.video} FPS</Typography.Text>
          <Typography.Text type="secondary">帧间隔 P95 {frameStats.p95} ms</Typography.Text>
          {cameraBusy && <Tag color="orange">相机连接中</Tag>}
          <Space size={4}>
            <Typography.Text type="secondary">RMS</Typography.Text>
            <RmsWaveform levelRef={rmsLevelRef} />
            <Typography.Text type="secondary">{meter.rms.toFixed(3)}</Typography.Text>
          </Space>
          <Typography.Text type="secondary">
            B {(featuresRef.current.bass * 100).toFixed(0)}% M {(featuresRef.current.mid * 100).toFixed(0)}% T {(featuresRef.current.treble * 100).toFixed(0)}%
          </Typography.Text>
          {status && (
            <Typography.Text type="secondary">
              {status.sampleRateHz}Hz {status.channels}ch 丢样{status.droppedSamples}
            </Typography.Text>
          )}
          <Tag color={stale ? "orange" : "default"}>
            AI {moodState === "neutral" ? "Neutral" : moodState}
            {stale && "·超时"}
          </Tag>
        </div>

        {(cameraError || glError || audioError || glWarning) && (
          <Alert
            type={cameraError || glError || audioError ? "error" : "warning"}
            className="stage-alert"
            content={[glError, cameraError, audioError, glWarning].filter(Boolean).join("；")}
          />
        )}

        {liveMode && (
          <div className={`live-hint${liveHintVisible ? " visible" : ""}`}>
            <IconLiveBroadcast aria-hidden="true" />
            <span>
              直播模式 · 按 <kbd>Esc</kbd> 退出
            </span>
            <Button
              size="mini"
              icon={isFullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? "退出全屏 (F)" : "全屏 (F)"}
            </Button>
            <Button size="mini" type="primary" onClick={() => setLive(false)}>
              退出
            </Button>
          </div>
        )}
      </div>

      <div className="side">
        <div className="topbar">
          <Tabs
            className="top-tabs"
            size="small"
            activeTab={activeFn}
            onChange={(key) => setActiveFn(key as FunctionKey)}
          >
            {TAB_ITEMS.map((tab) => (
              <Tabs.TabPane key={tab.key} title={tab.label} />
            ))}
          </Tabs>
          <Button
            className="theme-toggle"
            type="text"
            size="small"
            icon={themeMode === "dark" ? <IconSun /> : <IconMoon />}
            onClick={onToggleTheme}
          />
        </div>
        <div className="mode-control">
          <Radio.Group
            type="button"
            size="small"
            aria-label="滤镜控制模式"
            value={filterMode}
            onChange={setFilterMode}
            options={[
              { label: "默认模式", value: "default" },
              { label: "AI 模式", value: "ai" },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }} role="status">
            {filterMode === "default"
              ? "声音特征驱动，保留现有滤镜与映射。"
              : aiDriving
                ? "AI 混合氛围 · 缓慢变化"
                : "AI 暂无有效音乐情绪，平缓回到基础滤镜。"}
          </Typography.Text>
          {filterMode === "ai" && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              全局动态强度控制情绪影响；静音或分析中断时仍保持 AI 模式。
            </Typography.Text>
          )}
        </div>
        <div className="panel">{panelContent()}</div>
      </div>
    </div>
  );
}

function App() {
  const [themeMode, setThemeMode] = useState<"dark" | "light">("dark");

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    if (themeMode === "dark") {
      document.body.setAttribute("arco-theme", "dark");
    } else {
      document.body.removeAttribute("arco-theme");
    }
  }, [themeMode]);

  return (
    <DemoPage themeMode={themeMode} onToggleTheme={() => setThemeMode((m) => (m === "dark" ? "light" : "dark"))} />
  );
}

export default App;

