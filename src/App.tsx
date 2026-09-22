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
  Space,
  Tabs,
  Tag,
  Typography,
} from "@arco-design/web-react";
import { IconMoon, IconSun } from "@arco-design/web-react/icon";
import { useAiMood } from "./ai/useAiMood";
import { useAudioFeatures } from "./audio/useAudioFeatures";
import { ParamSliders } from "./components/ParamSliders";
import { RmsWaveform } from "./components/RmsWaveform";
import { FilterRenderer, type FitMode, type UniformValues } from "./gl/FilterRenderer";
import { THEME_PRESETS } from "./params/presets";
import { DEFAULT_PARAMS, type ParamValues } from "./params/schema";

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

interface CameraConfig {
  deviceId: string;
  resolution: "auto" | "720p" | "1080p";
  frameRate: number;
}

type SmoothedFeatures = Record<"rms" | "bass" | "treble" | "onset" | "centroid", number>;

function smoothToward(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function DemoPage({ themeMode, onToggleTheme }: { themeMode: "dark" | "light"; onToggleTheme: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraConfig, setCameraConfig] = useState<CameraConfig>({ deviceId: "", resolution: "auto", frameRate: 0 });
  const [cameraError, setCameraError] = useState("");
  const [glError, setGlError] = useState("");
  const [bypass, setBypass] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>("cover");
  const [params, setParams] = useState<ParamValues>({ ...DEFAULT_PARAMS });
  const [activeFn, setActiveFn] = useState<FunctionKey>("filter");
  const [fps, setFps] = useState(0);
  const [meter, setMeter] = useState<SmoothedFeatures>({ rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0 });

  const { featuresRef, running, source, status, start, stop } = useAudioFeatures();
  const { mood, moodState, workerReady, stale, selfTest } = useAiMood();

  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;
  const fitModeRef = useRef(fitMode);
  fitModeRef.current = fitMode;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const rmsLevelRef = useRef(0);

  const setParam = useCallback((key: string, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const startCamera = useCallback(async (config: CameraConfig) => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          ...(config.deviceId ? { deviceId: { exact: config.deviceId } } : {}),
          ...(config.resolution === "720p" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : {}),
          ...(config.resolution === "1080p" ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : {}),
          ...(config.frameRate > 0 ? { frameRate: { ideal: config.frameRate } } : {}),
        },
        audio: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      setCameraError("");
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((d) => d.kind === "videoinput"));
    } catch (error) {
      setCameraError(`相机不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  useEffect(() => {
    void startCamera(cameraConfig);
  }, [cameraConfig, startCamera]);

  useEffect(() => {
    let renderer: FilterRenderer | null = null;
    try {
      if (!canvasRef.current) throw new Error("canvas 未挂载");
      renderer = new FilterRenderer(canvasRef.current);
    } catch (error) {
      setGlError(error instanceof Error ? error.message : String(error));
    }

    let raf = 0;
    let last = performance.now();
    let lastStatus = 0;
    let fpsEma = 60;
    const smoothed: SmoothedFeatures = { rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0 };

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (dt > 0) fpsEma = fpsEma * 0.9 + (1 / dt) * 0.1;

      const p = paramsRef.current;
      const features = featuresRef.current;
      // 静音回落开启时，静音帧把动态通道目标归零，平滑回到基础值
      const silent = features.silence && p.silenceFallback > 0.5;
      smoothed.rms = smoothToward(smoothed.rms, silent ? 0 : features.rms, dt, p.rmsAttack, p.rmsRelease);
      smoothed.bass = smoothToward(smoothed.bass, silent ? 0 : features.bass, dt, p.bassAttack, p.bassRelease);
      smoothed.treble = smoothToward(smoothed.treble, silent ? 0 : features.treble, dt, p.trebleAttack, p.trebleRelease);
      smoothed.onset = smoothToward(smoothed.onset, silent ? 0 : features.onset, dt, p.onsetAttack, p.onsetRelease);
      smoothed.centroid = smoothToward(smoothed.centroid, features.centroid, dt, p.centroidAttack, p.centroidRelease);
      rmsLevelRef.current = smoothed.rms;

      if (renderer && videoRef.current) {
        const uniforms: UniformValues = {
          uTime: now / 1000,
          uRms: smoothed.rms,
          uBass: smoothed.bass,
          uTreble: smoothed.treble,
          uOnset: smoothed.onset,
          uCentroid: smoothed.centroid,
          uIntensity: p.intensity,
          uBypass: bypassRef.current ? 1 : 0,
          uBaseContrast: p.baseContrast,
          uBrightness: p.brightness,
          uVignette: p.vignette,
          uGrainBase: p.grainBase,
          uHighlightThr: p.highlightThr,
          uShadowCool: p.shadowCool,
          uMapRmsGlow: p.mapRmsGlow,
          uMapBassWarm: p.mapBassWarm,
          uMapTrebleGrain: p.mapTrebleGrain,
          uMapOnsetContrast: p.mapOnsetContrast,
          uMapCentroidTemp: p.mapCentroidTemp,
        };
        renderer.render(videoRef.current, uniforms, fitModeRef.current);
      }

      if (now - lastStatus > STATUS_UPDATE_MS) {
        lastStatus = now;
        setFps(Math.round(fpsEma));
        setMeter({ ...smoothed });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      renderer?.dispose();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [featuresRef]);

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
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
          const merged = { ...paramsRef.current };
          for (const key of Object.keys(DEFAULT_PARAMS)) {
            const value = Number((parsed as Record<string, unknown>)[key]);
            if (Number.isFinite(value)) merged[key] = value;
          }
          setParams(merged);
          Message.success("参数已导入");
        } catch {
          Message.error("JSON 解析失败，未做任何修改");
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
          <Space direction="vertical" size="medium">
            <Typography.Text>
              状态：
              {!workerReady && "Worker 启动中"}
              {workerReady && !mood && "等待 PCM 输入"}
              {workerReady && mood && (moodState === "neutral" ? "Neutral（置信度不足）" : moodState)}
              {stale && "（超时保持）"}
            </Typography.Text>
            {mood && (
              <Typography.Text type="secondary">
                happy {mood.happy.toFixed(2)} · sad {mood.sad.toFixed(2)} · relaxed {mood.relaxed.toFixed(2)} · aggressive{" "}
                {mood.aggressive.toFixed(2)} · 推理 {mood.inferenceMs.toFixed(1)}ms
              </Typography.Text>
            )}
            <Button onClick={selfTest}>发送自测 PCM</Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              模型未接入，当前为占位推理；后端 16 kHz PCM 通道就绪后经 sendPcm 喂入真实音频。
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
    <div className="page">
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
          <Button size="small" type="primary" onClick={() => void (running ? stop() : start())}>
            {running ? "停止音频" : "开始音频"}
          </Button>
          {running && (
            <Tag color={source === "tauri" ? "green" : "orange"}>{source === "tauri" ? "系统音频" : "模拟信号"}</Tag>
          )}
          <Checkbox checked={bypass} onChange={(checked) => setBypass(checked)}>
            A/B 原图
          </Checkbox>
        </div>

        <div className="stage-stats">
          <Typography.Text type="secondary">FPS {fps}</Typography.Text>
          <Space size={4}>
            <Typography.Text type="secondary">RMS</Typography.Text>
            <RmsWaveform levelRef={rmsLevelRef} />
            <Typography.Text type="secondary">{meter.rms.toFixed(3)}</Typography.Text>
          </Space>
          <Typography.Text type="secondary">
            B {(meter.bass * 100).toFixed(0)}% M {((1 - meter.bass - meter.treble) * 100).toFixed(0)}% T {(meter.treble * 100).toFixed(0)}%
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

        {(cameraError || glError) && (
          <Alert
            type="error"
            className="stage-alert"
            content={[glError, cameraError].filter(Boolean).join("；")}
          />
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

