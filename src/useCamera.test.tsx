import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCamera, type CameraConfig } from "./useCamera";

const config: CameraConfig = { deviceId: "", resolution: "auto", frameRate: 0 };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
function mockStream() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
const getUserMedia = vi.fn();

beforeEach(() => {
  getUserMedia.mockReset();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: Object.assign(new EventTarget(), {
    getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]),
  }) });
});
afterEach(() => vi.restoreAllMocks());

describe("camera stream ownership", () => {
  it("releases a late stream on unmount", async () => {
    const pending = deferred<MediaStream>();
    const media = mockStream();
    getUserMedia.mockReturnValue(pending.promise);
    const video = document.createElement("video");
    const ref = { current: video };
    const { unmount } = renderHook(() => useCamera(ref, config));
    unmount();
    await act(async () => pending.resolve(media.stream));
    expect(media.track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).not.toBe(media.stream);
  });

  it("does not let an obsolete request overwrite a newer camera", async () => {
    const old = deferred<MediaStream>();
    const a = mockStream();
    const b = mockStream();
    getUserMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce(b.stream);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    const ref = { current: video };
    const { rerender, unmount } = renderHook(({ selected }) => useCamera(ref, selected), { initialProps: { selected: config } });
    await act(async () => rerender({ selected: { ...config, deviceId: "new" } }));
    expect(video.srcObject).toBe(b.stream);
    await act(async () => old.resolve(a.stream));
    expect(a.track.stop).toHaveBeenCalledOnce();
    expect(b.track.stop).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(b.stream);
    unmount();
    expect(b.track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });

  it("does not detach the new stream when an old play promise rejects late", async () => {
    const a = mockStream();
    const b = mockStream();
    const playback = deferred<void>();
    getUserMedia.mockResolvedValueOnce(a.stream).mockResolvedValueOnce(b.stream);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockReturnValueOnce(playback.promise).mockResolvedValueOnce();
    const ref = { current: video };
    const { rerender, result, unmount } = renderHook(({ selected }) => useCamera(ref, selected), { initialProps: { selected: config } });
    await act(async () => {});
    await act(async () => rerender({ selected: { ...config, deviceId: "new" } }));
    await act(async () => playback.reject(new Error("old playback failed")));
    expect(video.srcObject).toBe(b.stream);
    expect(b.track.stop).not.toHaveBeenCalled();
    expect(result.current.error).toBe("");
    unmount();
  });

  it("reports ended tracks and retries without keeping an old stream", async () => {
    const a = mockStream();
    const b = mockStream();
    getUserMedia.mockResolvedValueOnce(a.stream).mockResolvedValueOnce(b.stream);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    const ref = { current: video };
    const { result, unmount } = renderHook(() => useCamera(ref, config));
    await act(async () => {});
    act(() => a.track.dispatchEvent(new Event("ended")));
    expect(result.current.error).toContain("断开");
    expect(video.srcObject).toBeNull();
    await act(async () => result.current.retry());
    expect(result.current.error).toBe("");
    expect(video.srcObject).toBe(b.stream);
    unmount();
  });

  it("reports permission and playback errors and releases acquired tracks", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));
    const video = document.createElement("video");
    const ref = { current: video };
    const { result, unmount } = renderHook(() => useCamera(ref, config));
    await act(async () => {});
    expect(result.current.error).toContain("Permission denied");
    expect(result.current.busy).toBe(false);
    const a = mockStream();
    getUserMedia.mockResolvedValueOnce(a.stream);
    vi.spyOn(video, "play").mockRejectedValueOnce(new Error("play failed"));
    await act(async () => result.current.retry());
    expect(result.current.error).toContain("play failed");
    expect(a.track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    unmount();
  });
});
