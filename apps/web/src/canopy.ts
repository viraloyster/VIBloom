// A painted guanacaste canopy: a wide, flat dome of leaf clumps, lit from
// above. Deterministic for a given seed; drawn once to a bitmap and reused.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CANOPY = { width: 1000, height: 560, groundY: 540 } as const;

interface Clump {
  x: number;
  y: number;
  r: number;
}

// Inside the dome silhouette: wide and flat, with a slightly lifted crown.
function inDome(x: number, y: number): boolean {
  const dx = (x - CANOPY.width / 2) / 480;
  if (Math.abs(dx) > 1) return false;
  const top = 130 + 150 * Math.pow(Math.abs(dx), 2.2);
  const bottom = 420 - 70 * Math.pow(Math.abs(dx), 3);
  return y > top && y < bottom;
}

function trunkAndBranches(g: CanvasRenderingContext2D, rand: () => number) {
  const cx = CANOPY.width / 2;
  const base = CANOPY.groundY;
  const bark = g.createLinearGradient(cx - 60, 0, cx + 60, 0);
  bark.addColorStop(0, "#1c140f");
  bark.addColorStop(0.45, "#3d2c20");
  bark.addColorStop(1, "#150f0b");
  g.fillStyle = bark;
  g.beginPath();
  g.moveTo(cx - 70, base);
  g.bezierCurveTo(cx - 40, base - 40, cx - 34, base - 90, cx - 30, base - 130);
  g.lineTo(cx + 30, base - 130);
  g.bezierCurveTo(cx + 34, base - 90, cx + 40, base - 40, cx + 70, base);
  g.closePath();
  g.fill();
  // Limbs fanning out under the dome, as guanacastes do.
  g.strokeStyle = "#2a1e16";
  g.lineCap = "round";
  for (let i = 0; i < 9; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const reach = 120 + rand() * 300;
    const lift = 130 + rand() * 120;
    g.lineWidth = 6 + rand() * 9;
    g.beginPath();
    g.moveTo(cx + side * 10, base - 120);
    g.quadraticCurveTo(
      cx + side * reach * 0.45,
      base - lift * 0.55,
      cx + side * reach,
      base - lift,
    );
    g.stroke();
  }
}

// fullness in [0, 1]: how much of the crown has grown in.
export function paintCanopy(fullness: number, seed = 7): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = CANOPY.width * scale;
  canvas.height = CANOPY.height * scale;
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  g.scale(scale, scale);
  const rand = rng(seed);

  trunkAndBranches(g, rand);

  const clumps: Clump[] = [];
  for (let tries = 0; clumps.length < 900 && tries < 60000; tries++) {
    const x = 10 + rand() * (CANOPY.width - 20);
    const y = 110 + rand() * 330;
    if (inDome(x, y)) clumps.push({ x, y, r: 13 + rand() * 20 });
  }
  // Lower clumps first, so the crown overlaps them as it does in light.
  clumps.sort((a, b) => b.y - a.y);
  const grown = Math.max(0.5, Math.min(1, 0.5 + 0.5 * fullness));
  const shown = clumps.filter((c, i) => i % 4 === 0 || rand() < grown || c.y > 330);

  // Shade of the whole crown: moonlight from above, dark underneath.
  const light = (y: number) => 1 - (y - 110) / 330;
  for (const c of shown) {
    const body = g.createRadialGradient(
      c.x - c.r * 0.3,
      c.y - c.r * 0.45,
      c.r * 0.1,
      c.x,
      c.y,
      c.r,
    );
    const top = 8 + 9 * light(c.y);
    body.addColorStop(0, `hsl(118 38% ${top.toFixed(1)}%)`);
    body.addColorStop(1, "hsl(130 45% 4%)");
    g.fillStyle = body;
    g.beginPath();
    g.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    g.fill();
  }
  for (const c of shown) {
    // Leaves: small blades, lighter toward the lit upper side of each clump.
    const leaves = Math.round(c.r * 9);
    for (let i = 0; i < leaves; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * c.r;
      const x = c.x + Math.cos(a) * d;
      const y = c.y + Math.sin(a) * d * 0.8;
      const lit = Math.max(
        0,
        Math.min(1, 0.5 - Math.sin(a) * (d / c.r) * 0.7 + (rand() - 0.5) * 0.3),
      );
      const l = 7 + 20 * lit * (0.45 + 0.55 * light(y)) + 6 * light(y);
      g.fillStyle = `hsl(${String(108 + rand() * 20)} ${String(35 + rand() * 20)}% ${l.toFixed(1)}%)`;
      g.beginPath();
      g.ellipse(x, y, 2 + rand() * 2.4, 1 + rand() * 1, rand() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }
  return canvas;
}
