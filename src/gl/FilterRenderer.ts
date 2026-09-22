import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

export interface FilterParams {
  rms: number;
  bass: number;
  treble: number;
  onset: number;
  centroid: number;
  intensity: number;
  bypass: boolean;
}

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
  private readonly uniformLocations: Record<string, WebGLUniformLocation | null>;

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

    this.uniformLocations = {
      uTexture: gl.getUniformLocation(program, "uTexture"),
      uTime: gl.getUniformLocation(program, "uTime"),
      uRms: gl.getUniformLocation(program, "uRms"),
      uBass: gl.getUniformLocation(program, "uBass"),
      uTreble: gl.getUniformLocation(program, "uTreble"),
      uOnset: gl.getUniformLocation(program, "uOnset"),
      uCentroid: gl.getUniformLocation(program, "uCentroid"),
      uIntensity: gl.getUniformLocation(program, "uIntensity"),
      uBypass: gl.getUniformLocation(program, "uBypass"),
    };
    gl.uniform1i(this.uniformLocations.uTexture, 0);
  }

  render(video: HTMLVideoElement, timeSeconds: number, params: FilterParams): void {
    const { gl } = this;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.resizeToVideo(video);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    gl.uniform1f(this.uniformLocations.uTime, timeSeconds);
    gl.uniform1f(this.uniformLocations.uRms, params.rms);
    gl.uniform1f(this.uniformLocations.uBass, params.bass);
    gl.uniform1f(this.uniformLocations.uTreble, params.treble);
    gl.uniform1f(this.uniformLocations.uOnset, params.onset);
    gl.uniform1f(this.uniformLocations.uCentroid, params.centroid);
    gl.uniform1f(this.uniformLocations.uIntensity, params.intensity);
    gl.uniform1f(this.uniformLocations.uBypass, params.bypass ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private resizeToVideo(video: HTMLVideoElement): void {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    const scale = Math.min(1, 1280 / width);
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.gl.viewport(0, 0, targetWidth, targetHeight);
    }
  }
}
