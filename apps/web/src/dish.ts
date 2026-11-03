// Spiral waves in a dish: the same Oregonator kinetics and parameters as a
// recorded run, spread over a plate with diffusion and integrated on the GPU.
// The tested claim is about the well-mixed system; the dish only shows that
// same chemistry in space. It is labelled as such wherever it appears.

export interface DishParams {
  s: number;
  q: number;
  eps: number;
  eps_prime: number;
}

const N = 256;
const DT = 0.002;
// Diffusion in grid units; small enough for tight, many-armed spirals.
const D = 0.008;

const VERTEX = `#version 300 es
in vec2 v; out vec2 uv;
void main() { uv = v * 0.5 + 0.5; gl_Position = vec4(v, 0.0, 1.0); }`;

// One step: Newton on the fast variable x (stiff near x = q), the exact
// exponential update for bromide y in the full model, explicit for z.
const STEP = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D S;
uniform float dt, s, q, eps, ep, D;
uniform int full;
void main() {
  vec2 px = vec2(1.0 / ${String(N)}.0);
  vec4 c = texture(S, uv);
  // Nine-point Laplacian: rounder fronts than the five-point one on a grid.
  vec4 lap = (4.0 * (texture(S, uv + vec2(px.x, 0.)) + texture(S, uv - vec2(px.x, 0.))
                   + texture(S, uv + vec2(0., px.y)) + texture(S, uv - vec2(0., px.y)))
              + texture(S, uv + px) + texture(S, uv - px)
              + texture(S, uv + vec2(px.x, -px.y)) + texture(S, uv + vec2(-px.x, px.y))
              - 20.0 * c) / 6.0;
  float x = c.r, y = c.g, z = c.b;
  float X = x;
  for (int k = 0; k < 4; k++) {
    float f, df;
    if (full == 1) { f = q * y - X * y + X * (1.0 - X); df = 1.0 - 2.0 * X - y; }
    else { f = X * (1.0 - X) - s * z * (X - q) / (X + q); df = 1.0 - 2.0 * X - 2.0 * q * s * z / ((X + q) * (X + q)); }
    float g = eps * (X - x) / dt - f - D * lap.r;
    X = max(X - g / (eps / dt - df), 1e-9);
  }
  float Y = y;
  if (full == 1) { float yeq = s * z / (q + X); Y = yeq + (y - yeq) * exp(-(q + X) * dt / ep); }
  float Z = z + dt * (X - z + 0.6 * D * lap.b);
  o = vec4(X, Y, Z, 1.0);
}`;

// Ferroin colours from the oxidised catalyst z, a glow on excited fronts, and
// a glass dish around it.
const SHOW = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D S;
uniform float zlo, zhi;
float lvl(vec2 p) { return clamp((log(texture(S, p).b) - log(zlo)) / (log(zhi) - log(zlo)), 0., 1.); }
float fr(vec2 p) { return clamp(log(texture(S, p).r / 1e-4) / log(5e3), 0., 1.); }
void main() {
  vec2 d = uv - 0.5; float r = length(d);
  vec2 px = vec2(1.0 / ${String(N)}.0);
  float g = 0.;
  for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) g += fr(uv + vec2(float(i), float(j)) * px * 1.5);
  g /= 49.0;
  float f = lvl(uv);
  float front = pow(fr(uv), 4.0);
  vec3 col = mix(vec3(0.30, 0.02, 0.06), vec3(0.78, 0.12, 0.16), smoothstep(0.0, 0.35, f));
  col = mix(col, vec3(0.10, 0.20, 0.75), smoothstep(0.35, 1.0, f));
  col += vec3(0.70, 0.92, 1.0) * front * 0.85 + vec3(0.35, 0.55, 1.0) * g * 0.9;
  col *= smoothstep(0.49, 0.475, r) * (1.0 - 0.45 * smoothstep(0.25, 0.49, r));
  col += vec3(0.75, 0.82, 0.95) * smoothstep(0.47, 0.485, r) * smoothstep(0.5, 0.487, r) * 0.55;
  col += vec3(1.0) * 0.10 * smoothstep(0.22, 0.0, length(d - vec2(-0.16, 0.2)));
  o = vec4(col, 1.0);
}`;

export interface Dish {
  canvas: HTMLCanvasElement;
  step(steps: number): void;
  dispose(): void;
}

function steadyX({ s, q }: DishParams) {
  const b = s + q - 1;
  return (-b + Math.sqrt(b * b + 4 * q * (1 + s))) / 2;
}

export function createDish(full: boolean, p: DishParams, size = 320): Dish | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const gl = canvas.getContext("webgl2");
  if (!gl?.getExtension("EXT_color_buffer_float")) return undefined;

  const program = (fragment: string) => {
    const pr = gl.createProgram();
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const sh = gl.createShader(type);
      if (!sh) return undefined;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return undefined;
      gl.attachShader(pr, sh);
    }
    gl.linkProgram(pr);
    return pr;
  };
  const stepProgram = program(STEP);
  const showProgram = program(SHOW);
  if (!stepProgram || !showProgram) return undefined;

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // Broken waves: excited segments with a refractory band on one side, so
  // their free ends curl into spirals. Seeded, so every viewer sees the same
  // start. Soft edges keep the grid from showing.
  const xs = steadyX(p);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const segments = Array.from({ length: 7 }, () => ({
    cx: 30 + rnd() * (N - 60),
    cy: 30 + rnd() * (N - 60),
    a: rnd() * 2 * Math.PI,
    len: 25 + rnd() * 30,
  }));
  const soft = (d: number, w: number) => Math.min(1, Math.max(0, (w - d) / 2 + 0.5));
  const init = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let ex = 0;
      let ref = 0;
      for (const g of segments) {
        const dx = i - g.cx;
        const dy = j - g.cy;
        const along = dx * Math.cos(g.a) + dy * Math.sin(g.a);
        const across = -dx * Math.sin(g.a) + dy * Math.cos(g.a);
        const inLen = soft(Math.abs(along - g.len / 2), g.len / 2);
        ex = Math.max(ex, inLen * soft(Math.abs(across), 3));
        ref = Math.max(ref, inLen * soft(Math.abs(across + 14), 11));
      }
      const x = xs + (0.5 - xs) * ex;
      const z = xs * (1 + 5 * ref);
      const k = (j * N + i) * 4;
      init[k] = x;
      init[k + 1] = (p.s * z) / (p.q + x);
      init[k + 2] = z;
      init[k + 3] = 1;
    }
  }
  const filter = gl.getExtension("OES_texture_float_linear") ? gl.LINEAR : gl.NEAREST;
  const textures = [0, 1].map(() => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, init);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  });
  const buffers = textures.map((t) => {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return fb;
  });
  const use = (pr: WebGLProgram) => {
    gl.useProgram(pr);
    const loc = gl.getAttribLocation(pr, "v");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  };
  const u = (pr: WebGLProgram, name: string) => gl.getUniformLocation(pr, name);
  let current = 0;

  return {
    canvas,
    step(steps: number) {
      use(stepProgram);
      gl.viewport(0, 0, N, N);
      gl.uniform1f(u(stepProgram, "dt"), DT);
      gl.uniform1f(u(stepProgram, "s"), p.s);
      gl.uniform1f(u(stepProgram, "q"), p.q);
      gl.uniform1f(u(stepProgram, "eps"), p.eps);
      gl.uniform1f(u(stepProgram, "ep"), p.eps_prime);
      gl.uniform1f(u(stepProgram, "D"), D);
      gl.uniform1i(u(stepProgram, "full"), full ? 1 : 0);
      for (let k = 0; k < steps; k++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, buffers[1 - current] ?? null);
        gl.bindTexture(gl.TEXTURE_2D, textures[current] ?? null);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        current = 1 - current;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, size, size);
      use(showProgram);
      gl.bindTexture(gl.TEXTURE_2D, textures[current] ?? null);
      gl.uniform1f(u(showProgram, "zlo"), 1e-4);
      gl.uniform1f(u(showProgram, "zhi"), 0.1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

// Simulated time per second of animation, so one cycle takes about 2.5 s.
export const STEPS_PER_FRAME = 25;
export const TIME_PER_FRAME = STEPS_PER_FRAME * DT;
