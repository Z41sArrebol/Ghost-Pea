import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Progress,
  Select,
  Slider,
  Space,
  Tag,
  theme,
  Typography,
} from "antd";
import { useAudioFeatures } from "./audio/useAudioFeatures";
import { useAiMood } from "./ai/useAiMood";
import { FilterRenderer } from "./gl/FilterRenderer";

const STATUS_UPDATE_MS = 250;

// 每个特征通道独立的 Attack/Release 时间常数（秒）。
// 瞬态类快攻快放，趋势类慢速跟随，画面才不抽搐。
const CHANNEL_TAU = {
  rms: { attack: 0.05, release: 0.35 },
  bass: { attack: 0.08, release: 0.4 },
  treble: { attack: 0.05, release: 0.3 },
  onset: { attack: 0.01, release: 0.15 },
  centroid: { attack: 0.2, release: 0.8 },
} as const;

type SmoothedFeatures = Record<keyof typeof CHANNEL_TAU, number>;

function smoothToward(current: number, target: number, dt: number, tau: { attack: number; release: number }): number {
  const t = target > current ? tau.attack : tau.release;
  return current + (target - current) * (1 - Math.exp(-dt / t));
}

function DemoPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [glError, setGlError] = useState("");
  const [bypass, setBypass] = useState(false);
  const [intensity, setIntensity] = useState(0.8);
  const [fps, setFps] = useState(0);
  const [meter, setMeter] = useState<SmoothedFeatures>({ rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0 });

  const { featuresRef, running, source, status, start, stop } = useAudioFeatures();
  const { mood, moodState, workerReady, stale, selfTest } = useAiMood();

  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  const startCamera = useCallback(async (id: string) => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    try {
      const constraints: MediaStreamConstraints = {
        video: id ? { deviceId: { exact: id } } : true,
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
    let renderer: FilterRenderer | null = null;
    try {
      if (!canvasRef.current) throw new Error("canvas 未挂载");
      renderer = new FilterRenderer(canvasRef.current);
    } catch (error) {
      setGlError(error instanceof Error ? error.message : String(error));
    }

    void startCamera("");

    let raf = 0;
    let last = performance.now();
    let lastStatus = 0;
    let fpsEma = 60;
    const smoothed: SmoothedFeatures = { rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0 };

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (dt > 0) fpsEma = fpsEma * 0.9 + (1 / dt) * 0.1;

      const features = featuresRef.current;
      // 静音时动态通道目标归零，平滑回落到主题基础值
      const silent = features.silence;
      smoothed.rms = smoothToward(smoothed.rms, silent ? 0 : features.rms, dt, CHANNEL_TAU.rms);
      smoothed.bass = smoothToward(smoothed.bass, silent ? 0 : features.bass, dt, CHANNEL_TAU.bass);
      smoothed.treble = smoothToward(smoothed.treble, silent ? 0 : features.treble, dt, CHANNEL_TAU.treble);
      smoothed.onset = smoothToward(smoothed.onset, silent ? 0 : features.onset, dt, CHANNEL_TAU.onset);
      smoothed.centroid = smoothToward(smoothed.centroid, features.centroid, dt, CHANNEL_TAU.centroid);

      if (renderer && videoRef.current) {
        renderer.render(videoRef.current, now / 1000, {
          ...smoothed,
          intensity: intensityRef.current,
          bypass: bypassRef.current,
        });
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
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [startCamera, featuresRef]);

  return (
    <div className="page">
      <Space align="baseline">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Ghost Pea · 共振镜头
        </Typography.Title>
        <Tag>前端链路验证 spike</Tag>
      </Space>

      <Card styles={{ body: { padding: 0, background: "#000", position: "relative" } }}>
        <video ref={videoRef} style={{ display: "none" }} playsInline muted />
        <canvas ref={canvasRef} className="preview" />
        {(cameraError || glError) && (
          <Alert
            type="error"
            showIcon
            style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}
            title={[glError, cameraError].filter(Boolean).join("；")}
          />
        )}
      </Card>

      <Card size="small">
        <Space wrap size="middle">
          <Space>
            <Typography.Text type="secondary">相机</Typography.Text>
            <Select
              style={{ width: 220 }}
              value={deviceId}
              onChange={(value) => { setDeviceId(value); void startCamera(value); }}
              options={[
                { value: "", label: "默认相机" },
                ...cameras.map((cam, i) => ({ value: cam.deviceId, label: cam.label || `相机 ${i + 1}` })),
              ]}
            />
          </Space>

          <Button type="primary" onClick={() => void (running ? stop() : start())}>
            {running ? "停止音频监听" : "开始音频监听"}
          </Button>
          {running && (
            <Tag color={source === "tauri" ? "green" : "orange"}>
              {source === "tauri" ? "系统音频（Rust 后端）" : "模拟信号（浏览器无后端）"}
            </Tag>
          )}

          <Checkbox checked={bypass} onChange={(e) => setBypass(e.target.checked)}>
            A/B：显示原图
          </Checkbox>

          <Button size="small" onClick={selfTest}>
            AI 自测
          </Button>

          <Space>
            <Typography.Text type="secondary">动态强度</Typography.Text>
            <Slider
              style={{ width: 160 }}
              min={0}
              max={100}
              value={Math.round(intensity * 100)}
              onChange={(value) => setIntensity(value / 100)}
              tooltip={{ formatter: (value) => `${value}%` }}
            />
            <Typography.Text type="secondary">{Math.round(intensity * 100)}%</Typography.Text>
          </Space>
        </Space>
      </Card>

      <Space size="large" wrap>
        <Typography.Text type="secondary">FPS：{fps}</Typography.Text>
        <Space size={8}>
          <Typography.Text type="secondary">RMS</Typography.Text>
          <Progress
            percent={Math.min(100, meter.rms * 100)}
            size={{ width: 120, height: 6 }}
            showInfo={false}
          />
          <Typography.Text type="secondary">{meter.rms.toFixed(3)}</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          B {(meter.bass * 100).toFixed(0)}% · M {((1 - meter.bass - meter.treble) * 100).toFixed(0)}% · T {(meter.treble * 100).toFixed(0)}%
        </Typography.Text>
        {status && (
          <Typography.Text type="secondary">
            {status.sampleRateHz} Hz / {status.channels} ch · 丢样 {status.droppedSamples}
          </Typography.Text>
        )}
        <Tag color={stale ? "orange" : "default"}>
          AI：
          {!workerReady && "Worker 启动中"}
          {workerReady && !mood && "等待输入"}
          {workerReady && mood && (moodState === "neutral" ? "Neutral（置信度不足）" : moodState)}
          {workerReady && mood && ` · ${mood.inferenceMs.toFixed(1)}ms`}
          {stale && " · 超时保持"}
        </Tag>
      </Space>
    </div>
  );
}

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <DemoPage />
    </ConfigProvider>
  );
}

export default App;
