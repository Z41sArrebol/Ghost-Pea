import { useCallback, useEffect, useState, type RefObject } from "react";

export interface CameraConfig {
  deviceId: string;
  resolution: "auto" | "720p" | "1080p";
  frameRate: number;
}

export function useCamera(videoRef: RefObject<HTMLVideoElement>, config: CameraConfig) {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let ownedStream: MediaStream | null = null;
    const refresh = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setCameras(devices.filter((device) => device.kind === "videoinput"));
      } catch {
        // 枚举失败不应中断已经打开的视频流。
      }
    };
    const release = () => {
      ownedStream?.getTracks().forEach((track) => track.stop());
      if (video.srcObject === ownedStream) video.srcObject = null;
    };
    const start = async () => {
      setBusy(true);
      setError("");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(config.deviceId ? { deviceId: { exact: config.deviceId } } : {}),
            ...(config.resolution === "720p" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : {}),
            ...(config.resolution === "1080p" ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : {}),
            ...(config.frameRate > 0 ? { frameRate: { ideal: config.frameRate } } : {}),
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        ownedStream = stream;
        for (const track of stream.getVideoTracks()) {
          track.addEventListener("ended", () => {
            if (cancelled) return;
            release();
            setError("相机已断开，请检查设备后重试预览");
          }, { once: true });
        }
        video.srcObject = stream;
        await video.play();
        if (!cancelled) await refresh();
      } catch (cause) {
        release();
        if (!cancelled) setError(`相机不可用：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void start();
    const onDeviceChange = () => void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
      release();
    };
  }, [config, videoRef, attempt]);

  return { cameras, error, busy, retry };
}
