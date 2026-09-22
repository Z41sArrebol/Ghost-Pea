import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedSize, FilterRenderer, type UniformValues } from "./FilterRenderer";
import { gradeColor, LUT_SIZE, type Look } from "./luts";
import { BLUR_SHADER, FRAGMENT_SHADER, HIGHLIGHT_SHADER, VERTEX_SHADER } from "./shaders";

// This stateful mock checks API contracts, not GLSL execution or GPU image quality.
const GL = {
  NO_ERROR: 0, OUT_OF_MEMORY: 0x0505,
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  TEXTURE0: 0x84c0, TEXTURE1: 0x84c1,
  TEXTURE_2D: 0x0de1, TEXTURE_3D: 0x806f,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072,
  LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f,
  RGBA: 0x1908, RGBA8: 0x8058, UNSIGNED_BYTE: 0x1401,
  FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  TRIANGLES: 0x0004, BLEND: 0x0be2, DEPTH_TEST: 0x0b71, COLOR_BUFFER_BIT: 0x4000,
} as const;

type Kind = "shader" | "program" | "texture" | "framebuffer" | "vao";
type Handle = { kind: Kind; id: number };
type UniformType = "float" | "vec2" | "sampler2D" | "sampler3D";
type Location = { program: Handle; name: string; type: UniformType };
type UniformValue = number | [number, number];
type Faults = {
  create?: { kind: Kind; at: number };
  compileAt?: number;
  linkAt?: number;
  framebufferStatusAt?: number;
  errorAt?: number;
};
type Image = {
  texture: Handle;
  target: number;
  width: number;
  height: number;
  depth: number;
  internalFormat: number;
  source: HTMLVideoElement | null;
  data: unknown;
  flipY: boolean;
};
type Draw = {
  program: Handle;
  framebuffer: Handle | null;
  attachment: Handle | null;
  viewport: number[];
  samples: Map<string, Handle>;
  units: Map<string, number>;
  uniforms: Map<string, UniformValue>;
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`WebGL mock: ${message}`);
}

function createWebGLMock(faults: Faults = {}) {
  let nextId = 1;
  const created: Handle[] = [];
  const deleted: Handle[] = [];
  const attempts: Record<Kind, number> = { shader: 0, program: 0, texture: 0, framebuffer: 0, vao: 0 };
  const shaders = new Map<Handle, { type: number; source: string; compiled: boolean }>();
  const programs = new Map<Handle, {
    shaders: Handle[];
    linked: boolean;
    locations: Map<string, Location>;
    values: Map<string, UniformValue>;
  }>();
  const bindings = new Map<number, Map<number, Handle | null>>();
  const textureTargets = new Map<Handle, number>();
  const storage = new Map<Handle, Image>();
  const attachments = new Map<Handle, Handle>();
  const images: Image[] = [];
  const subImages: Image[] = [];
  const draws: Draw[] = [];
  const clears: (Handle | null)[] = [];
  let activeUnit = 0;
  let currentProgram: Handle | null = null;
  let currentFramebuffer: Handle | null = null;
  let currentVao: Handle | null = null;
  let viewport = [0, 0, 0, 0];
  let flipY = false;
  let compileCalls = 0;
  let linkCalls = 0;
  let statusCalls = 0;
  let errorCalls = 0;
  let contextLost = false;

  function allocate(kind: Kind): Handle | null {
    attempts[kind]++;
    if (faults.create?.kind === kind && faults.create.at === attempts[kind]) return null;
    const handle = { kind, id: nextId++ };
    created.push(handle);
    return handle;
  }
  function assertLive(handle: Handle, kind: Kind) {
    check(handle && handle.kind === kind && created.includes(handle), `invalid ${kind} handle`);
    check(!deleted.includes(handle), `using deleted ${kind} ${handle.id}`);
  }
  function release(handle: Handle | null, kind: Kind) {
    if (handle === null) return; // WebGL permits delete*(null), not undefined mock handles.
    assertLive(handle, kind);
    deleted.push(handle);
  }
  function boundTexture(target: number): Handle {
    const texture = bindings.get(activeUnit)?.get(target);
    check(texture, `no texture on unit ${activeUnit}, target ${target}`);
    assertLive(texture, "texture");
    return texture;
  }
  function saveUniform(location: Location | null, value: UniformValue, types: UniformType[]) {
    if (location === null) return; // Optimized-out / absent uniforms are legal no-ops.
    check(location && location.program === currentProgram, "uniform belongs to another program");
    check(types.includes(location.type), `wrong setter for ${location.type} ${location.name}`);
    check((Array.isArray(value) ? value : [value]).every(Number.isFinite), "non-finite uniform");
    programs.get(location.program)!.values.set(location.name, value);
  }
  function recordImage(args: unknown[], sub: boolean): Image {
    const target = args[0] as number;
    const texture = boundTexture(target);
    const isVideo = sub || args.length === 6;
    const source = isVideo ? args[args.length - 1] as HTMLVideoElement : null;
    const image: Image = {
      texture, target,
      width: source ? source.videoWidth : args[3] as number,
      height: source ? source.videoHeight : args[4] as number,
      depth: target === GL.TEXTURE_3D ? args[5] as number : 1,
      internalFormat: sub ? storage.get(texture)!.internalFormat : args[2] as number,
      source, data: args[args.length - 1], flipY,
    };
    check(image.width > 0 && image.height > 0 && image.depth > 0, "invalid texture dimensions");
    if (sub) {
      const previous = storage.get(texture);
      check(previous && previous.width === image.width && previous.height === image.height,
        "texSubImage2D exceeds allocated source storage");
      subImages.push(image);
    } else {
      storage.set(texture, image);
      images.push(image);
    }
    return image;
  }

  const gl = {
    ...GL,
    createVertexArray: vi.fn(() => allocate("vao")),
    deleteVertexArray: vi.fn((handle: Handle | null) => release(handle, "vao")),
    bindVertexArray: vi.fn((handle: Handle | null) => {
      if (handle) assertLive(handle, "vao");
      currentVao = handle;
    }),
    createProgram: vi.fn(() => {
      const handle = allocate("program");
      if (handle) programs.set(handle, { shaders: [], linked: false, locations: new Map(), values: new Map() });
      return handle;
    }),
    deleteProgram: vi.fn((handle: Handle | null) => release(handle, "program")),
    createShader: vi.fn((type: number) => {
      const handle = allocate("shader");
      if (handle) shaders.set(handle, { type, source: "", compiled: false });
      return handle;
    }),
    deleteShader: vi.fn((handle: Handle | null) => release(handle, "shader")),
    shaderSource: vi.fn((handle: Handle, source: string) => {
      assertLive(handle, "shader");
      shaders.get(handle)!.source = source;
    }),
    compileShader: vi.fn((handle: Handle) => {
      assertLive(handle, "shader");
      shaders.get(handle)!.compiled = ++compileCalls !== faults.compileAt;
    }),
    getShaderParameter: vi.fn((handle: Handle, parameter: number) => {
      check(parameter === GL.COMPILE_STATUS, "unexpected shader parameter");
      return shaders.get(handle)!.compiled;
    }),
    getShaderInfoLog: vi.fn(() => "injected compile failure"),
    attachShader: vi.fn((program: Handle, shader: Handle) => {
      assertLive(program, "program");
      assertLive(shader, "shader");
      programs.get(program)!.shaders.push(shader);
    }),
    linkProgram: vi.fn((handle: Handle) => {
      assertLive(handle, "program");
      const program = programs.get(handle)!;
      check(program.shaders.length === 2 && program.shaders.every((s) => shaders.get(s)!.compiled),
        "linking uncompiled shaders");
      program.linked = ++linkCalls !== faults.linkAt;
      const source = program.shaders.map((s) => shaders.get(s)!.source).join("\n");
      // The actual shader declarations determine sampler targets and setter types.
      for (const match of source.matchAll(/uniform\s+(float|vec2|sampler2D|sampler3D)\s+(\w+)\s*;/g)) {
        const [, type, name] = match;
        program.locations.set(name, { program: handle, name, type: type as UniformType });
        program.values.set(name, type === "vec2" ? [0, 0] : 0);
      }
    }),
    getProgramParameter: vi.fn((handle: Handle, parameter: number) => {
      check(parameter === GL.LINK_STATUS, "unexpected program parameter");
      return programs.get(handle)!.linked;
    }),
    getProgramInfoLog: vi.fn(() => "injected link failure"),
    getUniformLocation: vi.fn((handle: Handle, name: string) => programs.get(handle)!.locations.get(name) ?? null),
    useProgram: vi.fn((handle: Handle) => {
      assertLive(handle, "program");
      check(programs.get(handle)!.linked, "using unlinked program");
      currentProgram = handle;
    }),
    uniform1f: vi.fn((location: Location | null, value: number) => saveUniform(location, value, ["float"])),
    uniform1i: vi.fn((location: Location | null, value: number) => {
      check(Number.isInteger(value), "sampler unit must be an integer");
      saveUniform(location, value, ["sampler2D", "sampler3D"]);
    }),
    uniform2f: vi.fn((location: Location | null, x: number, y: number) => saveUniform(location, [x, y], ["vec2"])),
    createTexture: vi.fn(() => allocate("texture")),
    deleteTexture: vi.fn((handle: Handle | null) => release(handle, "texture")),
    activeTexture: vi.fn((unit: number) => { activeUnit = unit - GL.TEXTURE0; }),
    bindTexture: vi.fn((target: number, handle: Handle | null) => {
      if (handle) {
        assertLive(handle, "texture");
        check(!textureTargets.has(handle) || textureTargets.get(handle) === target, "texture target changed");
        textureTargets.set(handle, target);
      }
      if (!bindings.has(activeUnit)) bindings.set(activeUnit, new Map());
      bindings.get(activeUnit)!.set(target, handle);
    }),
    texParameteri: vi.fn((target: number, _parameter: number, _value: number) => { boundTexture(target); }),
    pixelStorei: vi.fn((parameter: number, value: boolean) => {
      check(parameter === GL.UNPACK_FLIP_Y_WEBGL, "unexpected unpack parameter");
      flipY = value;
    }),
    texImage2D: vi.fn((...args: unknown[]) => { recordImage(args, false); }),
    texSubImage2D: vi.fn((...args: unknown[]) => { recordImage(args, true); }),
    texImage3D: vi.fn((...args: unknown[]) => { recordImage(args, false); }),
    createFramebuffer: vi.fn(() => allocate("framebuffer")),
    deleteFramebuffer: vi.fn((handle: Handle | null) => release(handle, "framebuffer")),
    bindFramebuffer: vi.fn((target: number, handle: Handle | null) => {
      check(target === GL.FRAMEBUFFER, "unexpected framebuffer target");
      if (handle) assertLive(handle, "framebuffer");
      currentFramebuffer = handle;
    }),
    framebufferTexture2D: vi.fn((target: number, attachment: number, textureTarget: number, texture: Handle, level: number) => {
      check(target === GL.FRAMEBUFFER && attachment === GL.COLOR_ATTACHMENT0 && textureTarget === GL.TEXTURE_2D && level === 0,
        "invalid framebuffer attachment parameters");
      check(currentFramebuffer, "attaching texture to default framebuffer");
      assertLive(texture, "texture");
      attachments.set(currentFramebuffer, texture);
    }),
    checkFramebufferStatus: vi.fn((target: number) => {
      check(target === GL.FRAMEBUFFER && currentFramebuffer, "checking wrong framebuffer");
      check(attachments.has(currentFramebuffer), "framebuffer has no attachment");
      return ++statusCalls === faults.framebufferStatusAt ? GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : GL.FRAMEBUFFER_COMPLETE;
    }),
    viewport: vi.fn((x: number, y: number, width: number, height: number) => { viewport = [x, y, width, height]; }),
    disable: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(() => { clears.push(currentFramebuffer); }),
    getError: vi.fn(() => ++errorCalls === faults.errorAt ? GL.OUT_OF_MEMORY : GL.NO_ERROR),
    isContextLost: vi.fn(() => contextLost),
    drawArrays: vi.fn((mode: number, first: number, count: number) => {
      check(mode === GL.TRIANGLES && first === 0 && count === 3, "not a fullscreen triangle");
      check(currentVao && currentProgram, "draw without VAO or program");
      assertLive(currentVao, "vao");
      assertLive(currentProgram, "program");
      const program = programs.get(currentProgram)!;
      const attachment = currentFramebuffer ? attachments.get(currentFramebuffer) ?? null : null;
      if (currentFramebuffer) {
        assertLive(currentFramebuffer, "framebuffer");
        check(attachment && storage.has(attachment), "draw to unallocated framebuffer");
        const image = storage.get(attachment)!;
        check(viewport[2] === image.width && viewport[3] === image.height, "viewport differs from target storage");
      }
      const samples = new Map<string, Handle>();
      const units = new Map<string, number>();
      const unitTypes = new Map<number, UniformType>();
      for (const [name, location] of program.locations) {
        if (location.type !== "sampler2D" && location.type !== "sampler3D") continue;
        const unit = program.values.get(name) as number;
        check(!unitTypes.has(unit) || unitTypes.get(unit) === location.type, "different sampler types alias one texture unit");
        unitTypes.set(unit, location.type);
        const target = location.type === "sampler3D" ? GL.TEXTURE_3D : GL.TEXTURE_2D;
        const texture = bindings.get(unit)?.get(target);
        check(texture && storage.has(texture), `unbound or unallocated ${name}`);
        assertLive(texture, "texture");
        // Ignore textures bound on unused units: only this program's samplers matter.
        check(texture !== attachment, `render-target feedback through ${name}`);
        samples.set(name, texture);
        units.set(name, unit);
      }
      draws.push({ program: currentProgram, framebuffer: currentFramebuffer, attachment,
        viewport: [...viewport], samples, units, uniforms: new Map(program.values) });
    }),
  };
  return {
    gl, faults, created, deleted, images, subImages, draws, clears, shaders, programs, storage, attachments,
    live: (kind?: Kind) => created.filter((handle) => !deleted.includes(handle) && (!kind || handle.kind === kind)),
    loseContext: () => { contextLost = true; },
  };
}

type Mock = ReturnType<typeof createWebGLMock>;
const renderers: FilterRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
});

function createCanvas(mock: Mock) {
  const canvas = document.createElement("canvas");
  const layout = { width: 1280, height: 720 };
  Object.defineProperties(canvas, {
    clientWidth: { get: () => layout.width },
    clientHeight: { get: () => layout.height },
  });
  vi.spyOn(canvas, "getContext").mockReturnValue(mock.gl as unknown as WebGL2RenderingContext);
  return { canvas, layout };
}

function setup(faults: Faults = {}) {
  const mock = createWebGLMock(faults);
  const { canvas, layout } = createCanvas(mock);
  const renderer = new FilterRenderer(canvas);
  renderers.push(renderer);
  return { mock, gl: mock.gl, renderer, canvas, layout };
}

function createVideo(callbacks = true, playbackQuality = true) {
  const video = document.createElement("video");
  const state = { width: 1280, height: 720, readyState: 2, currentTime: 0, totalVideoFrames: 0 };
  let nextId = 1;
  const pending = new Map<number, VideoFrameRequestCallback>();
  const history = new Map<number, VideoFrameRequestCallback>();
  const request = vi.fn((callback: VideoFrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, callback);
    history.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => { pending.delete(id); });
  Object.defineProperties(video, {
    videoWidth: { get: () => state.width },
    videoHeight: { get: () => state.height },
    readyState: { get: () => state.readyState },
    currentTime: { get: () => state.currentTime },
    srcObject: { writable: true, value: null },
    requestVideoFrameCallback: { value: callbacks ? request : undefined },
    cancelVideoFrameCallback: { value: callbacks ? cancel : undefined },
    getVideoPlaybackQuality: { value: playbackQuality ? () => ({ totalVideoFrames: state.totalVideoFrames }) : undefined },
  });
  function deliver(id: number, presentedFrames = 1, stale = false) {
    const callback = (stale ? history : pending).get(id);
    check(callback, `missing video callback ${id}`);
    pending.delete(id);
    callback(0, {
      width: state.width, height: state.height, mediaTime: state.currentTime,
      presentedFrames, presentationTime: 0, expectedDisplayTime: 0, processingDuration: 0,
    });
  }
  function latestId() {
    const ids = [...pending.keys()];
    check(ids.length === 1, `expected one outstanding callback, got ${ids.length}`);
    return ids[0];
  }
  return { video, state, request, cancel, pending, deliver, latestId };
}

function values(overrides: Partial<UniformValues> = {}): UniformValues {
  return {
    uTime: 0, uBypass: 0, uContrast: 1, uBrightness: 1, uTemperature: 0,
    uShadowCool: 0, uHighlightThr: 0.7, uVignette: 0, uGrain: 0,
    uBloom: 0.25, uBloomWarm: 0.15, uLookDark: 0.3, uLookCalm: 0.2, uLookBright: 0.1,
    ...overrides,
  };
}

function expectFreed(mock: Mock) {
  expect(mock.live()).toEqual([]);
  expect(mock.deleted).toHaveLength(mock.created.length);
  expect(new Set(mock.deleted).size).toBe(mock.created.length);
  for (const handle of mock.created) expect(mock.deleted.filter((item) => item === handle)).toHaveLength(1);
}

function targetStorage(mock: Mock) {
  return mock.images.filter((image) => image.target === GL.TEXTURE_2D && image.data === null);
}

function videoUploads(mock: Mock) {
  return [...mock.images, ...mock.subImages].filter((image) => image.source !== null);
}

describe("boundedSize", () => {
  it.each([
    [1280, 720, 1920, 2073600, 1280, 720],
    [3840, 2160, 1920, 2073600, 1920, 1080],
    [2160, 3840, 1920, 2073600, 1080, 1920],
    [2160, 2160, 1920, 2073600, 1440, 1440],
    [7680, 2160, 1920, 2073600, 1920, 540],
    [480, 270, 512, 131072, 480, 270],
    [512, 512, 512, 131072, 362, 362],
    [1001, 501, 500, 1000000, 500, 250],
    [10.9, 20.9, 100, 10000, 10, 20],
    [0, 0, 1920, 2073600, 1, 1],
    [0, 720, 1920, 2073600, 1, 720],
    [1280, 0, 1920, 2073600, 1280, 1],
    [0.1, 0.2, 512, 131072, 1, 1],
    [1920, 1080, 1, 1, 1, 1],
  ])("bounds %s × %s (side %s, pixels %s) to %s × %s", (w, h, side, pixels, expectedW, expectedH) => {
    expect(boundedSize(w, h, side, pixels)).toEqual([expectedW, expectedH]);
  });

  it("keeps positive integer dimensions within both budgets over a size matrix", () => {
    for (const width of [1, 31, 320, 1024, 1920, 4096, 8192]) {
      for (const height of [1, 17, 240, 1080, 2160, 4320]) {
        const [w, h] = boundedSize(width, height, 1920, 2073600);
        expect(Number.isInteger(w) && Number.isInteger(h)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(1);
        expect(h).toBeGreaterThanOrEqual(1);
        expect(Math.max(w, h)).toBeLessThanOrEqual(1920);
        expect(w * h).toBeLessThanOrEqual(2073600);
        expect(w).toBeLessThanOrEqual(width);
        expect(h).toBeLessThanOrEqual(height);
      }
    }
  });
});

describe("FilterRenderer WebGL initialization and passes", () => {
  it("uses real shader sources, unique handles, and three distinct RGBA8 3D LUTs", () => {
    const { renderer, canvas, mock, gl } = setup();
    expect(canvas.getContext).toHaveBeenCalledWith("webgl2", { antialias: false, alpha: false });
    expect(new Set(mock.created).size).toBe(mock.created.length);
    expect(mock.created.every((handle) => typeof handle === "object" && handle !== null)).toBe(true);
    expect([...mock.shaders.values()].filter((shader) => shader.type === GL.VERTEX_SHADER).map((shader) => shader.source))
      .toEqual([VERTEX_SHADER, VERTEX_SHADER, VERTEX_SHADER]);
    expect([...mock.shaders.values()].filter((shader) => shader.type === GL.FRAGMENT_SHADER).map((shader) => shader.source))
      .toEqual([FRAGMENT_SHADER, HIGHLIGHT_SHADER, BLUR_SHADER]);
    expect(gl.deleteShader).toHaveBeenCalledTimes(6);
    expect(mock.live("shader")).toHaveLength(0);
    expect(mock.live("program")).toHaveLength(3);
    expect(mock.live("texture")).toHaveLength(5);
    expect(gl.createFramebuffer).not.toHaveBeenCalled();
    const luts = mock.images.filter((image) => image.target === GL.TEXTURE_3D);
    expect(luts).toHaveLength(3);
    expect(new Set(luts.map((image) => image.texture)).size).toBe(3);
    for (const [index, look] of (["dark", "calm", "bright"] as Look[]).entries()) {
      const lut = luts[index];
      expect([lut.width, lut.height, lut.depth, lut.internalFormat, lut.flipY])
        .toEqual([LUT_SIZE, LUT_SIZE, LUT_SIZE, GL.RGBA8, false]);
      expect(lut.data).toBeInstanceOf(Uint8Array);
      const data = lut.data as Uint8Array;
      expect(data).toHaveLength(LUT_SIZE ** 3 * 4);
      for (const [r, g, b] of [[0, 0, 0], [31, 31, 31], [9, 17, 25]]) {
        const offset = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4;
        const expected = gradeColor([r / 31, g / 31, b / 31], look).map((channel) => Math.round(channel * 255));
        expect([...data.slice(offset, offset + 4)]).toEqual([...expected, 255]);
      }
    }
    expect(new Set(luts.map((lut) => [...(lut.data as Uint8Array).slice(0, 4)].join(","))).size).toBe(3);
    renderer.dispose();
    expectFreed(mock);
  });

  it.each([
    ["bypass", { uBypass: 1 }],
    ["zero bloom", { uBloom: 0, uBloomWarm: 0 }],
    ["negligible bloom", { uBloom: 0.0005, uBloomWarm: 0.0005 }],
  ] as const)("%s draws only the composite and allocates no targets", (_label, overrides) => {
    const { renderer, mock, gl } = setup();
    const { video } = createVideo();
    const created = [...mock.created];
    for (let frame = 0; frame < 3; frame++) {
      expect(renderer.render(video, values(overrides), "contain")).toBe(true);
      expect(mock.draws).toHaveLength(frame + 1);
      const draw = mock.draws[frame];
      expect(draw.framebuffer).toBeNull();
      expect(draw.uniforms.get("uBloom")).toBe(0);
      expect(draw.uniforms.get("uBloomWarm")).toBe(0);
    }
    expect(mock.created).toEqual(created);
    expect(gl.createFramebuffer).not.toHaveBeenCalled();
    expect(targetStorage(mock)).toEqual([]);
    expect(renderer.uploads).toBe(1);
  });

  it.each([
    ["cool only", { uBloom: 0.4, uBloomWarm: 0 }],
    ["warm only", { uBloom: 0, uBloomWarm: 0.4 }],
    ["mixed", { uBloom: 0.2, uBloomWarm: 0.3 }],
  ] as const)("%s bloom has four feedback-free draws with distinct sampler types", (_label, overrides) => {
    const { renderer, mock } = setup();
    expect(renderer.render(createVideo().video, values(overrides), "contain")).toBe(true);
    expect(mock.draws).toHaveLength(4);
    const [highlight, horizontal, vertical, composite] = mock.draws;
    const source = videoUploads(mock)[0].texture;
    expect(highlight.samples.get("uTexture")).toBe(source);
    expect(highlight.attachment).not.toBe(horizontal.attachment);
    expect(horizontal.samples.get("uTexture")).toBe(highlight.attachment);
    expect(vertical.samples.get("uTexture")).toBe(horizontal.attachment);
    expect(vertical.attachment).toBe(highlight.attachment);
    expect(composite.framebuffer).toBeNull();
    expect(composite.samples.get("uTexture")).toBe(source);
    expect(composite.samples.get("uBloomTexture")).toBe(vertical.attachment);
    expect(horizontal.uniforms.get("uDirection")).toEqual([1 / 320, 0]);
    expect(vertical.uniforms.get("uDirection")).toEqual([0, 1 / 180]);
    expect(composite.uniforms.get("uBloom")).toBe(overrides.uBloom);
    expect(composite.uniforms.get("uBloomWarm")).toBe(overrides.uBloomWarm);
    expect(mock.draws.map((draw) => draw.viewport)).toEqual([
      [0, 0, 320, 180], [0, 0, 320, 180], [0, 0, 320, 180], [0, 0, 1280, 720],
    ]);
    const lutTextures = mock.images.filter((image) => image.target === GL.TEXTURE_3D).map((image) => image.texture);
    for (const draw of [highlight, composite]) {
      expect(draw.units.get("uTexture")).toBe(0);
      for (const [index, name] of ["uDarkLut", "uCalmLut", "uBrightLut"].entries()) {
        expect(draw.units.get(name)).toBe(index + 2);
        expect(draw.samples.get(name)).toBe(lutTextures[index]);
      }
    }
    expect(composite.units.get("uBloomTexture")).toBe(1);
    for (const draw of mock.draws) {
      for (const texture of draw.samples.values()) expect(texture).not.toBe(draw.attachment);
    }
  });

  it("reuses all resources and target sizes across frames, including the previous composite binding", () => {
    const { renderer, mock, gl } = setup();
    const source = createVideo();
    renderer.render(source.video, values(), "contain");
    const created = [...mock.created];
    const firstTargets = [...targetStorage(mock)];
    expect(firstTargets).toHaveLength(2);
    expect(firstTargets.map(({ width, height }) => [width, height])).toEqual([[320, 180], [320, 180]]);
    for (let frame = 1; frame <= 5; frame++) {
      source.deliver(source.latestId(), frame);
      expect(renderer.render(source.video, values({ uTime: frame }), "contain")).toBe(true);
      expect(mock.draws).toHaveLength((frame + 1) * 4);
      expect(mock.draws.slice(-4).map((draw) => draw.framebuffer)).toEqual(mock.draws.slice(0, 4).map((draw) => draw.framebuffer));
      expect(mock.created).toEqual(created);
      expect(targetStorage(mock)).toEqual(firstTargets);
    }
    expect(gl.createFramebuffer).toHaveBeenCalledTimes(2);
    expect(gl.createTexture).toHaveBeenCalledTimes(7);
    expect(gl.texImage3D).toHaveBeenCalledTimes(3);
    expect(mock.subImages).toHaveLength(5);
  });

  it("reallocates only target storage on layout resize without accumulating resources", () => {
    const { renderer, mock, layout } = setup();
    const { video } = createVideo();
    renderer.render(video, values(), "cover");
    const created = [...mock.created];
    const targets = targetStorage(mock).map((image) => image.texture);
    const initialNonTargets = mock.images.filter((image) => !targets.includes(image.texture));
    for (const [index, [width, height, targetWidth, targetHeight]] of [
      [800, 600, 200, 150], [1920, 1080, 480, 270], [1280, 720, 320, 180],
    ].entries()) {
      layout.width = width;
      layout.height = height;
      renderer.render(video, values(), "cover");
      expect(mock.created).toEqual(created);
      expect(targetStorage(mock)).toHaveLength(2 * (index + 2));
      expect(targetStorage(mock).slice(-2).map((image) => [image.texture, image.width, image.height]))
        .toEqual(targets.map((texture) => [texture, targetWidth, targetHeight]));
      expect(mock.draws.slice(-4).map((draw) => draw.viewport)).toEqual([
        [0, 0, targetWidth, targetHeight], [0, 0, targetWidth, targetHeight],
        [0, 0, targetWidth, targetHeight], [0, 0, width, height],
      ]);
      const count = mock.images.length;
      renderer.render(video, values(), "cover");
      expect(mock.images).toHaveLength(count);
    }
    expect(mock.images.filter((image) => !targets.includes(image.texture))).toEqual(initialNonTargets);
    expect(videoUploads(mock)).toHaveLength(1);
    expect(mock.live("texture")).toHaveLength(7);
    expect(mock.live("framebuffer")).toHaveLength(2);
  });

  it("does not reallocate when layout changes but rounded bloom dimensions do not", () => {
    const { renderer, mock, layout } = setup();
    const { video } = createVideo();
    renderer.render(video, values(), "cover");
    const count = mock.images.length;
    layout.width = 1281;
    layout.height = 721;
    renderer.render(video, values(), "cover");
    expect(mock.images).toHaveLength(count);
    expect(mock.draws.slice(-4)[0].viewport).toEqual([0, 0, 320, 180]);
    expect(mock.draws[mock.draws.length - 1].viewport).toEqual([0, 0, 1281, 721]);
  });

  it("switches bloom off and on without allocating or sampling obsolete targets", () => {
    const { renderer, mock } = setup();
    const { video } = createVideo();
    renderer.render(video, values(), "contain");
    const created = [...mock.created];
    const bloomTexture = mock.draws[3].samples.get("uBloomTexture");
    renderer.render(video, values({ uBypass: 1 }), "contain");
    renderer.render(video, values({ uBloom: 0, uBloomWarm: 0 }), "contain");
    expect(mock.draws).toHaveLength(6);
    for (const draw of mock.draws.slice(4)) {
      expect(draw.framebuffer).toBeNull();
      expect(draw.samples.get("uBloomTexture")).not.toBe(bloomTexture);
      expect(mock.storage.get(draw.samples.get("uBloomTexture")!)!.data).toEqual(new Uint8Array([0, 0, 0, 255]));
    }
    renderer.render(video, values(), "contain");
    expect(mock.draws).toHaveLength(10);
    expect(mock.draws[9].samples.get("uBloomTexture")).toBe(bloomTexture);
    expect(mock.created).toEqual(created);
    expect(targetStorage(mock)).toHaveLength(2);
  });

  it.each([
    ["cover", 720, 1280, 720, 1280, 0.31640625, 1],
    ["cover", 1600, 600, 1600, 600, 1, 2 / 3],
    ["contain", 720, 1280, 1280, 720, 1, 1],
  ] as const)("uses consistent UV scaling for %s on %s × %s", (fit, width, height, outputWidth, outputHeight, x, y) => {
    const { renderer, mock, layout, canvas } = setup();
    Object.assign(layout, { width, height });
    renderer.render(createVideo().video, values(), fit);
    expect([canvas.width, canvas.height]).toEqual([outputWidth, outputHeight]);
    for (const draw of [mock.draws[0], mock.draws[3]]) {
      expect(draw.uniforms.get("uUvScaleX")).toBeCloseTo(x);
      expect(draw.uniforms.get("uUvScaleY")).toBeCloseTo(y);
    }
  });

  it("disposes every created resource exactly once and prevents later rendering", () => {
    const { renderer, mock, gl } = setup();
    const source = createVideo();
    renderer.render(source.video, values(), "contain");
    const callback = source.latestId();
    renderer.dispose();
    expectFreed(mock);
    const deletes = [gl.deleteShader, gl.deleteProgram, gl.deleteTexture, gl.deleteFramebuffer, gl.deleteVertexArray]
      .map((fn) => fn.mock.calls.length);
    renderer.dispose();
    expect(renderer.render(source.video, values(), "contain")).toBe(false);
    source.deliver(callback, 3, true);
    expect([gl.deleteShader, gl.deleteProgram, gl.deleteTexture, gl.deleteFramebuffer, gl.deleteVertexArray]
      .map((fn) => fn.mock.calls.length)).toEqual(deletes);
    expect(mock.draws).toHaveLength(4);
    expect(source.cancel).toHaveBeenCalledExactlyOnceWith(callback);
    expect(source.request).toHaveBeenCalledTimes(1);
  });

  it("stops before upload, allocation, or draw after context loss", () => {
    const { renderer, mock } = setup();
    const source = createVideo();
    mock.loseContext();
    const created = [...mock.created];
    expect(renderer.render(source.video, values(), "contain")).toBe(false);
    expect(source.request).not.toHaveBeenCalled();
    expect(videoUploads(mock)).toEqual([]);
    expect(mock.draws).toEqual([]);
    expect(mock.created).toEqual(created);
  });
});

describe("FilterRenderer partial initialization and bloom failure", () => {
  it("reports an unavailable WebGL2 context without attempting to render", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    expect(() => new FilterRenderer(canvas)).toThrow("WebGL2");
  });

  const allocationFailures: [Kind, number][] = [
    ["vao", 1], ["program", 1], ["program", 2], ["program", 3],
    ["shader", 1], ["shader", 2], ["shader", 5], ["shader", 6],
    ["texture", 1], ["texture", 2], ["texture", 3], ["texture", 4], ["texture", 5],
  ];
  it.each(allocationFailures)("frees partial initialization when %s allocation #%s returns null", (kind, at) => {
    const mock = createWebGLMock({ create: { kind, at } });
    const { canvas } = createCanvas(mock);
    expect(() => new FilterRenderer(canvas)).toThrow();
    expectFreed(mock);
    expect(mock.draws).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6])("frees all resources when shader compile #%s fails", (compileAt) => {
    const mock = createWebGLMock({ compileAt });
    const { canvas } = createCanvas(mock);
    expect(() => new FilterRenderer(canvas)).toThrow("injected compile failure");
    expectFreed(mock);
  });

  it.each([1, 2, 3])("frees shaders and programs when program link #%s fails", (linkAt) => {
    const mock = createWebGLMock({ linkAt });
    const { canvas } = createCanvas(mock);
    expect(() => new FilterRenderer(canvas)).toThrow("injected link failure");
    expectFreed(mock);
  });

  it("frees initialized LUTs and all other resources on constructor GL error", () => {
    const mock = createWebGLMock({ errorAt: 1 });
    const { canvas } = createCanvas(mock);
    expect(() => new FilterRenderer(canvas)).toThrow("初始化失败");
    expect(mock.gl.texImage3D).toHaveBeenCalledTimes(3);
    expectFreed(mock);
  });

  const bloomFailures: [string, Faults][] = [
    ["first texture allocation", { create: { kind: "texture", at: 6 } }],
    ["second texture allocation", { create: { kind: "texture", at: 7 } }],
    ["first framebuffer allocation", { create: { kind: "framebuffer", at: 1 } }],
    ["second framebuffer allocation", { create: { kind: "framebuffer", at: 2 } }],
    ["first incomplete framebuffer", { framebufferStatusAt: 1 }],
    ["second incomplete framebuffer", { framebufferStatusAt: 2 }],
    ["target storage GL error", { errorAt: 2 }],
  ];
  it.each(bloomFailures)("falls back safely after %s and frees every allocation on disposal", (_label, fault) => {
    const { renderer, mock, gl } = setup(fault);
    const { video } = createVideo();
    expect(renderer.render(video, values(), "contain")).toBe(true);
    expect(renderer.warning).toMatch(/光晕/);
    expect(mock.draws).toHaveLength(1);
    const draw = mock.draws[0];
    expect(draw.framebuffer).toBeNull();
    expect(draw.samples.get("uTexture")).toBe(videoUploads(mock)[0].texture);
    expect(draw.uniforms.get("uBloom")).toBe(0);
    expect(draw.uniforms.get("uBloomWarm")).toBe(0);
    const empty = mock.storage.get(draw.samples.get("uBloomTexture")!)!;
    expect([empty.width, empty.height]).toEqual([1, 1]);
    expect(empty.data).toEqual(new Uint8Array([0, 0, 0, 255]));
    const allocations = [gl.createTexture.mock.calls.length, gl.createFramebuffer.mock.calls.length, mock.images.length];
    for (let frame = 0; frame < 3; frame++) expect(renderer.render(video, values(), "contain")).toBe(true);
    expect(mock.draws).toHaveLength(4);
    expect([gl.createTexture.mock.calls.length, gl.createFramebuffer.mock.calls.length, mock.images.length]).toEqual(allocations);
    renderer.dispose();
    renderer.dispose();
    expectFreed(mock);
  });

  it.each(bloomFailures)("releases abandoned bloom resources immediately after %s", (_label, fault) => {
    const { renderer, mock } = setup(fault);
    const baseTextures = [...mock.live("texture")];
    renderer.render(createVideo().video, values(), "contain");
    expect.soft(mock.live("texture")).toEqual(baseTextures);
    expect.soft(mock.live("framebuffer")).toEqual([]);
  });

  it("safely disables bloom if reallocation fails and releases the abandoned targets", () => {
    const { renderer, mock, layout } = setup();
    const { video } = createVideo();
    const baseTextures = [...mock.live("texture")];
    renderer.render(video, values(), "cover");
    mock.faults.framebufferStatusAt = 3;
    Object.assign(layout, { width: 800, height: 600 });
    expect(renderer.render(video, values(), "cover")).toBe(true);
    expect(mock.draws).toHaveLength(5);
    expect(mock.draws[4].framebuffer).toBeNull();
    expect(mock.draws[4].uniforms.get("uBloom")).toBe(0);
    expect(renderer.warning).not.toBeNull();
    expect.soft(mock.live("texture")).toEqual(baseTextures);
    expect.soft(mock.live("framebuffer")).toEqual([]);
  });
});

describe("FilterRenderer video upload gating and callback lifecycle", () => {
  it("an asynchronous video callback marks dirty and schedules its successor but never draws or uploads", async () => {
    const { renderer, mock, gl } = setup();
    const source = createVideo();
    renderer.render(source.video, values(), "contain");
    const drawCount = gl.drawArrays.mock.calls.length;
    const imageCount = gl.texImage2D.mock.calls.length;
    const pending = source.latestId();
    await Promise.resolve().then(() => source.deliver(pending, 10));
    expect(source.request).toHaveBeenCalledTimes(2);
    expect(source.pending.size).toBe(1);
    expect(gl.drawArrays).toHaveBeenCalledTimes(drawCount);
    expect(gl.texImage2D).toHaveBeenCalledTimes(imageCount);
    expect(gl.texSubImage2D).not.toHaveBeenCalled();
    expect(renderer.uploads).toBe(1);
    expect(renderer.videoFrames).toBe(1);
    renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(2);
    expect(mock.subImages).toHaveLength(1);
    expect(mock.draws).toHaveLength(8);
  });

  it("uploads once per dirty frame even when repeatedly rendering animated uniforms", () => {
    const { renderer, mock } = setup();
    const source = createVideo();
    for (let i = 0; i < 4; i++) renderer.render(source.video, values({ uTime: i }), "contain");
    expect(videoUploads(mock)).toHaveLength(1);
    source.state.currentTime = 1;
    renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(1); // rVFC, not currentTime, is authoritative here.
    source.deliver(source.latestId(), 7);
    source.deliver(source.latestId(), 10);
    expect(renderer.videoFrames).toBe(4);
    expect(renderer.uploads).toBe(1);
    for (let i = 0; i < 4; i++) renderer.render(source.video, values({ uTime: i }), "contain");
    expect(videoUploads(mock)).toHaveLength(2);
    expect(mock.subImages).toHaveLength(1);
    expect(renderer.uploads).toBe(2);
    expect(mock.draws).toHaveLength(36);
    expect(source.pending.size).toBe(1);
  });

  it("uses texSubImage2D for same-sized frames and reallocates source storage only for a new resolution", () => {
    const { renderer, mock, gl } = setup();
    const source = createVideo();
    const noBloom = values({ uBloom: 0, uBloomWarm: 0 });
    renderer.render(source.video, noBloom, "contain");
    source.deliver(source.latestId());
    renderer.render(source.video, noBloom, "contain");
    expect(mock.subImages).toHaveLength(1);
    source.state.width = 640;
    source.state.height = 480;
    source.deliver(source.latestId(), 2);
    renderer.render(source.video, noBloom, "contain");
    expect(mock.images.filter((image) => image.source)).toHaveLength(2);
    expect(mock.subImages).toHaveLength(1);
    const uploads = videoUploads(mock);
    expect(new Set(uploads.map((image) => image.texture)).size).toBe(1);
    expect(uploads.every((image) => image.flipY)).toBe(true);
    expect(gl.pixelStorei).toHaveBeenLastCalledWith(GL.UNPACK_FLIP_Y_WEBGL, false);
    expect(gl.createTexture).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["not ready", 1, 1280, 720],
    ["zero width", 2, 0, 720],
    ["zero height", 2, 1280, 0],
  ] as const)("clears the default framebuffer and does not draw or upload when %s", (_label, readyState, width, height) => {
    const { renderer, mock } = setup();
    const source = createVideo();
    Object.assign(source.state, { readyState, width, height });
    expect(renderer.render(source.video, values(), "cover")).toBe(false);
    expect(videoUploads(mock)).toEqual([]);
    expect(mock.draws).toEqual([]);
    expect(mock.clears).toEqual([null]);
    expect(mock.gl.clearColor).toHaveBeenCalledWith(0, 0, 0, 1);
    expect(mock.gl.clear).toHaveBeenCalledWith(GL.COLOR_BUFFER_BIT);
    expect(mock.gl.createFramebuffer).not.toHaveBeenCalled();
    Object.assign(source.state, { readyState: 2, width: 1280, height: 720 });
    expect(renderer.render(source.video, values(), "cover")).toBe(true);
    expect(renderer.uploads).toBe(1);
  });

  it("cancels the latest callback on video-element change and a stale callback cannot reschedule", () => {
    const { renderer, mock } = setup();
    const first = createVideo();
    const second = createVideo();
    renderer.render(first.video, values(), "contain");
    first.deliver(first.latestId());
    const oldId = first.latestId();
    renderer.render(second.video, values(), "contain");
    expect(first.cancel).toHaveBeenCalledExactlyOnceWith(oldId);
    expect(first.pending.size).toBe(0);
    const drawCount = mock.draws.length;
    const uploads = renderer.uploads;
    const frames = renderer.videoFrames;
    first.deliver(oldId, 100, true);
    expect(first.request).toHaveBeenCalledTimes(2);
    expect(second.pending.size).toBe(1);
    expect(mock.draws).toHaveLength(drawCount);
    expect(renderer.uploads).toBe(uploads);
    expect(renderer.videoFrames).toBe(frames);
    renderer.render(second.video, values(), "contain");
    expect(renderer.uploads).toBe(uploads);
  });

  it("cancels and rebinds on srcObject changes, guarding stale callbacks even after A → B → A", () => {
    const { renderer } = setup();
    const source = createVideo();
    const streamA = {} as MediaStream;
    const streamB = {} as MediaStream;
    source.video.srcObject = streamA;
    renderer.render(source.video, values(), "contain");
    const firstId = source.latestId();
    source.video.srcObject = streamB;
    source.deliver(firstId, 50, true); // Source changed before the next UI render.
    expect(source.request).toHaveBeenCalledTimes(1);
    expect(renderer.videoFrames).toBe(0);
    renderer.render(source.video, values(), "contain");
    expect(source.cancel).toHaveBeenNthCalledWith(1, firstId);
    const secondId = source.latestId();
    source.video.srcObject = streamA;
    renderer.render(source.video, values(), "contain");
    expect(source.cancel).toHaveBeenNthCalledWith(2, secondId);
    const currentId = source.latestId();
    source.deliver(firstId, 100, true);
    source.deliver(secondId, 101, true);
    expect(source.request).toHaveBeenCalledTimes(3);
    expect(source.latestId()).toBe(currentId);
    expect(renderer.videoFrames).toBe(0);
    expect(renderer.uploads).toBe(3);
    renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(3);
  });

  it("does not display the previous source while the replacement is not ready", () => {
    const { renderer, mock } = setup();
    const source = createVideo();
    renderer.render(source.video, values(), "contain");
    const oldId = source.latestId();
    source.video.srcObject = {} as MediaStream;
    source.state.readyState = 1;
    expect(renderer.render(source.video, values(), "contain")).toBe(false);
    expect(source.cancel).toHaveBeenCalledWith(oldId);
    expect(mock.draws).toHaveLength(4);
    expect(mock.clears).toEqual([null]);
    source.state.readyState = 2;
    expect(renderer.render(source.video, values(), "contain")).toBe(true);
    expect(renderer.uploads).toBe(2);
  });

  it("unmount/dispose cancels the most recently scheduled callback and stale delivery does nothing", () => {
    const { renderer, mock } = setup();
    const source = createVideo();
    renderer.render(source.video, values(), "contain");
    source.deliver(source.latestId(), 1);
    const id = source.latestId();
    const frames = renderer.videoFrames;
    renderer.dispose();
    expect(source.cancel).toHaveBeenCalledExactlyOnceWith(id);
    expect(source.pending.size).toBe(0);
    source.deliver(id, 100, true);
    renderer.dispose();
    expect(source.request).toHaveBeenCalledTimes(2);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(renderer.videoFrames).toBe(frames);
    expect(renderer.uploads).toBe(1);
    expect(mock.draws).toHaveLength(4);
    expectFreed(mock);
  });

  it.each([true, false])("fallback currentTime gate uploads only on time changes (playback quality: %s)", (playbackQuality) => {
    const { renderer, mock } = setup();
    const source = createVideo(false, playbackQuality);
    source.state.totalVideoFrames = 10;
    for (let i = 0; i < 3; i++) renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(1);
    expect(renderer.videoFrames).toBe(1);
    source.state.totalVideoFrames = 13;
    source.state.currentTime = 0.033;
    renderer.render(source.video, values(), "contain");
    renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(2);
    expect(renderer.videoFrames).toBe(playbackQuality ? 4 : 2);
    source.state.currentTime = 0; // Backward seeks must dirty the source too.
    renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(3);
    expect(renderer.videoFrames).toBe(playbackQuality ? 5 : 3);
    expect(videoUploads(mock)).toHaveLength(3);
    expect(source.request).not.toHaveBeenCalled();
    renderer.dispose();
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it("fallback resets its time gate when the stream changes at the same currentTime", () => {
    const { renderer, mock } = setup();
    const source = createVideo(false);
    renderer.render(source.video, values(), "contain");
    source.video.srcObject = {} as MediaStream;
    renderer.render(source.video, values(), "contain");
    renderer.render(source.video, values(), "contain");
    expect(renderer.uploads).toBe(2);
    expect(videoUploads(mock)).toHaveLength(2);
  });
});
