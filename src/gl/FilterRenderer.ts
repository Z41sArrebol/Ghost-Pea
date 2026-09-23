import { createLut, LUT_SIZE, type Look } from "./luts";
import { BLUR_SHADER, COPY_SHADER, FRAGMENT_SHADER, HIGHLIGHT_SHADER, VERTEX_SHADER } from "./shaders";

const FLOAT_UNIFORMS = [
  "uTime", "uBypass", "uContrast", "uBrightness", "uTemperature", "uShadowCool",
  "uHighlightThr", "uVignette", "uGrain", "uBloom", "uBloomWarm",
  "uLookDark", "uLookCalm", "uLookBright", "uSoftClip", "uSaturation", "uGammaMid",
] as const;

export type UniformValues = Record<(typeof FLOAT_UNIFORMS)[number], number>;
export type FitMode = "cover" | "contain";

// 三级多尺度柔光：1/4、1/8、1/16 分辨率，结构参考 three.js UnrealBloomPass（MIT）。
const BLOOM_LEVELS = 3;
const BLOOM_UNITS = [1, 5, 6] as const;

type Program = { handle: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };

export function boundedSize(width: number, height: number, maxSide: number, maxPixels: number): [number, number] {
  const scale = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

export class FilterRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Program[] = [];
  private readonly textures: WebGLTexture[] = [];
  private readonly targets: Target[] = [];
  private readonly luts: WebGLTexture[] = [];
  private vao: WebGLVertexArrayObject | null = null;
  private source!: WebGLTexture;
  private emptyBloom!: WebGLTexture;
  private composite!: Program;
  private highlight!: Program;
  private blur!: Program;
  private copy!: Program;
  private bloomSizes: [number, number][] = [];
  private bloomFailed = false;
  private disposed = false;
  private video: HTMLVideoElement | null = null;
  private stream: HTMLVideoElement["srcObject"] = null;
  private videoCallback: number | null = null;
  private videoGeneration = 0;
  private dirty = true;
  private hasFrame = false;
  private lastVideoTime = -1;
  private lastPresented = 0;
  private lastQualityFrames = 0;
  private sourceWidth = 0;
  private sourceHeight = 0;
  videoFrames = 0;
  uploads = 0;
  warning: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("当前环境不支持 WebGL2");
    this.gl = gl;
    try {
      this.vao = gl.createVertexArray();
      if (!this.vao) throw new Error("无法创建绘制资源");
      this.composite = this.createProgram(FRAGMENT_SHADER);
      this.highlight = this.createProgram(HIGHLIGHT_SHADER);
      this.blur = this.createProgram(BLUR_SHADER);
      this.copy = this.createProgram(COPY_SHADER);
      this.source = this.createTexture2D();
      this.emptyBloom = this.createTexture2D();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      for (const look of ["dark", "calm", "bright"] as Look[]) {
        const texture = gl.createTexture();
        if (!texture) throw new Error("无法创建调色纹理");
        this.textures.push(texture);
        this.luts.push(texture);
        gl.bindTexture(gl.TEXTURE_3D, texture);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, createLut(look));
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error("显卡资源初始化失败，请关闭其他高负载程序后重试");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private createProgram(fragment: string): Program {
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    const handle = gl.createProgram();
    if (!handle) throw new Error("无法创建 WebGL program");
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("无法创建 shader");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader 编译失败");
        gl.attachShader(handle, shader);
      }
      gl.linkProgram(handle);
      if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(handle) || "shader 链接失败");
      const names = [...FLOAT_UNIFORMS, "uTexture", "uBloomTex0", "uBloomTex1", "uBloomTex2", "uDarkLut", "uCalmLut", "uBrightLut", "uUvScaleX", "uUvScaleY", "uDirection"];
      const program = { handle, uniforms: new Map(names.map((name) => [name, gl.getUniformLocation(handle, name)])) };
      this.programs.push(program);
      return program;
    } catch (error) {
      gl.deleteProgram(handle);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  private createTexture2D(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("无法创建纹理");
    this.textures.push(texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return texture;
  }

  private bindVideo(video: HTMLVideoElement): void {
    if (this.video === video && this.stream === video.srcObject) return;
    this.cancelVideoCallback();
    this.video = video;
    this.stream = video.srcObject;
    this.dirty = true;
    this.hasFrame = false;
    this.lastVideoTime = -1;
    this.lastPresented = 0;
    this.lastQualityFrames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const generation = this.videoGeneration;
    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
        if (this.disposed || generation !== this.videoGeneration || this.stream !== video.srcObject) return;
        this.videoFrames += this.lastPresented > 0 ? Math.max(1, metadata.presentedFrames - this.lastPresented) : 1;
        this.lastPresented = metadata.presentedFrames;
        this.dirty = true;
        this.videoCallback = video.requestVideoFrameCallback(onFrame);
      };
      this.videoCallback = video.requestVideoFrameCallback(onFrame);
    }
  }

  private cancelVideoCallback(): void {
    this.videoGeneration++;
    if (this.videoCallback !== null) this.video?.cancelVideoFrameCallback(this.videoCallback);
    this.videoCallback = null;
  }

  private prepareBloom(): void {
    const gl = this.gl;
    const [width, height] = boundedSize(Math.max(1, this.canvas.width / 4), Math.max(1, this.canvas.height / 4), 512, 131072);
    if (this.bloomSizes.length && width === this.bloomSizes[0][0] && height === this.bloomSizes[0][1]) return;
    const sizes: [number, number][] = [];
    for (let level = 0; level < BLOOM_LEVELS; level++) {
      sizes.push([Math.max(1, Math.floor(width / 2 ** level)), Math.max(1, Math.floor(height / 2 ** level))]);
    }
    while (this.targets.length < BLOOM_LEVELS * 2) {
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("无法创建光晕缓冲");
      try {
        this.targets.push({ texture: this.createTexture2D(), framebuffer });
      } catch (error) {
        gl.deleteFramebuffer(framebuffer);
        throw error;
      }
    }
    for (const [index, target] of this.targets.entries()) {
      const [targetWidth, targetHeight] = sizes[Math.floor(index / 2)];
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetWidth, targetHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("光晕缓冲不可用");
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error("光晕缓冲分配失败");
    this.bloomSizes = sizes;
  }

  private bindPass(program: Program, framebuffer: WebGLFramebuffer | null, width: number, height: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program.handle);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(program.uniforms.get("uTexture") ?? null, 0);
  }

  private setGrade(program: Program, values: UniformValues, scaleX: number, scaleY: number): void {
    const gl = this.gl;
    for (const name of FLOAT_UNIFORMS) gl.uniform1f(program.uniforms.get(name) ?? null, values[name]);
    gl.uniform1f(program.uniforms.get("uUvScaleX") ?? null, scaleX);
    gl.uniform1f(program.uniforms.get("uUvScaleY") ?? null, scaleY);
    for (const [index, name] of ["uDarkLut", "uCalmLut", "uBrightLut"].entries()) {
      gl.activeTexture(gl.TEXTURE0 + index + 2);
      gl.bindTexture(gl.TEXTURE_3D, this.luts[index]);
      gl.uniform1i(program.uniforms.get(name) ?? null, index + 2);
    }
  }

  render(video: HTMLVideoElement, values: UniformValues, fit: FitMode): boolean {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) return false;
    this.bindVideo(video);
    this.resize(video, fit);
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      if (typeof video.requestVideoFrameCallback !== "function" && video.currentTime !== this.lastVideoTime) {
        const count = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        this.videoFrames += count > this.lastQualityFrames ? count - this.lastQualityFrames : 1;
        this.lastQualityFrames = count;
        this.dirty = true;
      }
      if (this.dirty) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.source);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        if (this.sourceWidth !== video.videoWidth || this.sourceHeight !== video.videoHeight) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          this.sourceWidth = video.videoWidth;
          this.sourceHeight = video.videoHeight;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        this.lastVideoTime = video.currentTime;
        this.hasFrame = true;
        this.dirty = false;
        this.uploads++;
      }
    }
    if (!this.hasFrame || video.readyState < 2) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return false;
    }
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const canvasAspect = this.canvas.width / this.canvas.height;
    const videoAspect = video.videoWidth / video.videoHeight;
    const scaleX = fit === "cover" ? Math.min(1, canvasAspect / videoAspect) : 1;
    const scaleY = fit === "cover" ? Math.min(1, videoAspect / canvasAspect) : 1;
    let bloomActive = values.uBypass < 0.5 && values.uBloom + values.uBloomWarm > 0.001 && !this.bloomFailed;
    if (bloomActive) {
      try {
        gl.activeTexture(gl.TEXTURE0);
        this.prepareBloom();
      } catch (error) {
        this.bloomFailed = true;
        bloomActive = false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        for (const target of this.targets.splice(0)) {
          gl.deleteFramebuffer(target.framebuffer);
          gl.deleteTexture(target.texture);
          this.textures.splice(this.textures.indexOf(target.texture), 1);
        }
        this.warning = `已关闭光晕，保留基础滤镜：${String(error)}`;
      }
    }
    if (bloomActive) {
      const [width, height] = this.bloomSizes[0];
      this.bindPass(this.highlight, this.targets[0].framebuffer, width, height, this.source);
      this.setGrade(this.highlight, values, scaleX, scaleY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (let level = 0; level < BLOOM_LEVELS; level++) {
        const [levelWidth, levelHeight] = this.bloomSizes[level];
        const a = this.targets[level * 2];
        const b = this.targets[level * 2 + 1];
        if (level > 0) {
          this.bindPass(this.copy, a.framebuffer, levelWidth, levelHeight, this.targets[(level - 1) * 2].texture);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        this.bindPass(this.blur, b.framebuffer, levelWidth, levelHeight, a.texture);
        gl.uniform2f(this.blur.uniforms.get("uDirection") ?? null, 1 / levelWidth, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.bindPass(this.blur, a.framebuffer, levelWidth, levelHeight, b.texture);
        gl.uniform2f(this.blur.uniforms.get("uDirection") ?? null, 0, 1 / levelHeight);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    this.bindPass(this.composite, null, this.canvas.width, this.canvas.height, this.source);
    this.setGrade(this.composite, values, scaleX, scaleY);
    gl.uniform1f(this.composite.uniforms.get("uBloom") ?? null, bloomActive ? values.uBloom : 0);
    gl.uniform1f(this.composite.uniforms.get("uBloomWarm") ?? null, bloomActive ? values.uBloomWarm : 0);
    for (const [level, unit] of BLOOM_UNITS.entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, bloomActive ? this.targets[level * 2].texture : this.emptyBloom);
      gl.uniform1i(this.composite.uniforms.get(`uBloomTex${level}`) ?? null, unit);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  private resize(video: HTMLVideoElement, fit: FitMode): void {
    const width = fit === "cover" ? this.canvas.clientWidth : video.videoWidth;
    const height = fit === "cover" ? this.canvas.clientHeight : video.videoHeight;
    if (!width || !height) return;
    const [targetWidth, targetHeight] = boundedSize(width, height, 1920, 1920 * 1080);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelVideoCallback();
    for (const target of this.targets) this.gl.deleteFramebuffer(target.framebuffer);
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    for (const program of this.programs) this.gl.deleteProgram(program.handle);
    this.gl.deleteVertexArray(this.vao);
  }
}
