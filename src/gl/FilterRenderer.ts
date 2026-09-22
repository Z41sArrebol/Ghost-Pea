import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

const FLOAT_UNIFORMS = [
  "uTime",
  "uRms",
  "uBass",
  "uTreble",
  "uOnset",
  "uCentroid",
  "uIntensity",
  "uBypass",
  "uBaseContrast",
  "uBrightness",
  "uVignette",
  "uGrainBase",
  "uHighlightThr",
  "uShadowCool",
  "uMapRmsGlow",
  "uMapBassWarm",
  "uMapTrebleGrain",
  "uMapOnsetContrast",
  "uMapCentroidTemp",
] as const;

export type UniformName = (typeof FLOAT_UNIFORMS)[number];

export type UniformValues = Record<UniformName, number>;

export type FitMode = "cover" | "contain";

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建 shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader 编译失败: ${gl.getShaderInfoLog(shader) ?? "未知错误"}`);
  }
  return shader;
}

export class FilterRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly texture: WebGLTexture;
  private readonly uniformLocations: Record<UniformName, WebGLUniformLocation | null>;
  private readonly uvScaleXLocation: WebGLUniformLocation | null;
  private readonly uvScaleYLocation: WebGLUniformLocation | null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (!gl) throw new Error("当前环境不支持 WebGL2");
    this.canvas = canvas;
    this.gl = gl;

    const program = gl.createProgram();
    if (!program) throw new Error("无法创建 WebGL program");
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program 链接失败: ${gl.getProgramInfoLog(program) ?? "未知错误"}`);
    }
    gl.useProgram(program);

    const texture = gl.createTexture();
    if (!texture) throw new Error("无法创建纹理");
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 视频解码出来的帧是倒置的，上传时翻转回来
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this.uniformLocations = Object.fromEntries(
      FLOAT_UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<UniformName, WebGLUniformLocation | null>;
    this.uvScaleXLocation = gl.getUniformLocation(program, "uUvScaleX");
    this.uvScaleYLocation = gl.getUniformLocation(program, "uUvScaleY");
    gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
  }

  render(video: HTMLVideoElement, values: UniformValues, fit: FitMode): void {
    const { gl } = this;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.resize(video, fit);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    let uvScaleX = 1;
    let uvScaleY = 1;
    if (fit === "cover" && video.videoWidth && video.videoHeight && this.canvas.width && this.canvas.height) {
      const canvasAspect = this.canvas.width / this.canvas.height;
      const videoAspect = video.videoWidth / video.videoHeight;
      if (canvasAspect > videoAspect) {
        uvScaleY = videoAspect / canvasAspect;
      } else {
        uvScaleX = canvasAspect / videoAspect;
      }
    }
    for (const name of FLOAT_UNIFORMS) {
      gl.uniform1f(this.uniformLocations[name], values[name]);
    }
    gl.uniform1f(this.uvScaleXLocation, uvScaleX);
    gl.uniform1f(this.uvScaleYLocation, uvScaleY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private resize(video: HTMLVideoElement, fit: FitMode): void {
    if (fit === "cover") {
      // cover 模式画布跟随显示区域尺寸，由 CSS 撑满 stage
      const cssWidth = this.canvas.clientWidth;
      const cssHeight = this.canvas.clientHeight;
      if (!cssWidth || !cssHeight) return;
      const scale = Math.min(1, 1920 / cssWidth);
      const targetWidth = Math.round(cssWidth * scale);
      const targetHeight = Math.round(cssHeight * scale);
      if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
        this.canvas.width = targetWidth;
        this.canvas.height = targetHeight;
        this.gl.viewport(0, 0, targetWidth, targetHeight);
      }
      return;
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    const scale = Math.min(1, 1920 / width);
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.gl.viewport(0, 0, targetWidth, targetHeight);
    }
  }
}
