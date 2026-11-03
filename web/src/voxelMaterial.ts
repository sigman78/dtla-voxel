import * as THREE from 'three';
import { QUAD_PARS } from './quadGeometry';
import type { Meta } from './types';
import { dataTexture } from './util';

// material ids, as in the data pipeline's palette (meta.palette[i][3]); 7, 14 and 17 are unused
export const MAT = { SOLID: 0, WALL: 1, GLASS: 2, LEAF: 3, WATER: 4, LAMP: 5, METAL: 6, GRASS: 8, MARK: 9, SOIL: 10, CAR: 11,
  ROOF: 12, CONCRETE: 13, BRONZE: 15, SIGN: 16, SIGNBAND: 18, RIBBON: 19, CLASSIC: 20, WINDOW: 21, STUCCO: 22,
  CITY_HALL: 23, BROAD: 24, DISNEY: 25, MISSION: 26, US_BANK: 27, WILSHIRE: 28, DISNEY_GLASS: 29 } as const;

type U<T> = { value: T };
export interface VoxelUniforms {
  [name: string]: THREE.IUniform;
  uPalette: U<THREE.Texture>;
  uLampMap: U<THREE.Texture>;
  uSize: U<THREE.Vector2>;
  uNight: U<number>;
  uTime: U<number>;
  uHorizon: U<THREE.Color>;
  uLit: U<number>;
  uAlbedo: U<number>;
  uLandmarkFrames: U<THREE.Vector4[]>;
  uLandmarkCrownBases: U<number[]>;
  uLandmarkSpireBases: U<number[]>;
}

export function makeUniforms(meta: Meta): VoxelUniforms {
  const frames = Array.from({ length: 6 }, () => new THREE.Vector4());
  const crownBases = Array<number>(6).fill(1e6);
  const spireBases = Array<number>(6).fill(1e6);
  for (const style of meta.landmarkStyles ?? []) {
    const index = style.material - MAT.CITY_HALL;
    if (Number.isInteger(index) && index >= 0 && index < frames.length
      && style.origin.every(Number.isFinite) && Number.isFinite(style.angle)) {
      frames[index].set(...style.origin, style.angle);
      if (style.crownBase !== undefined && Number.isFinite(style.crownBase)) crownBases[index] = style.crownBase;
      if (style.spireBase !== undefined && Number.isFinite(style.spireBase)) spireBases[index] = style.spireBase;
    }
  }
  return {
    uLandmarkFrames: { value: frames },
    uLandmarkCrownBases: { value: crownBases },
    uLandmarkSpireBases: { value: spireBases },
    uPalette: { value: makePaletteTexture(meta.palette) },
    uLampMap: { value: makeLampTexture(meta) },
    uSize: { value: new THREE.Vector2(meta.W, meta.D) },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uHorizon: { value: new THREE.Color(0.8, 0.75, 0.7) },
    uLit: { value: 0 },
    uAlbedo: { value: 0.7 },
  };
}

// up to 4096 entries (r, g, b, material) in a 64 x 64 texture
function makePaletteTexture(palette: Meta['palette']) {
  const size = 64, data = new Uint8Array(size * size * 4);
  palette.forEach((p, i) => data.set(p, i * 4));
  const tex = dataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return tex;
}

// warm pools of street light on the ground (2 m texels)
function makeLampTexture(meta: Meta) {
  const s = 0.5, cv = document.createElement('canvas');
  cv.width = Math.max(1, meta.W * s); cv.height = Math.max(1, meta.D * s);
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y] of meta.lamps ?? []) {
    const cx = (x + 0.5) * s, cy = (y + 0.5) * s, r = 20 * s, gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [t, c] of [[0, 'rgba(255,214,160,0.65)'], [0.3, 'rgba(255,204,150,0.28)'], [0.65, 'rgba(255,196,140,0.08)'], [1, 'rgba(255,190,130,0)']] as const) gr.addColorStop(t, c);
    ctx.fillStyle = gr;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

const NORMAL_FROM_IDX = `
  vec3 normalFromIdx(float i) {
    if (i < 0.5) return vec3(-1., 0., 0.);
    if (i < 1.5) return vec3(1., 0., 0.);
    if (i < 2.5) return vec3(0., 0., -1.);
    if (i < 3.5) return vec3(0., 0., 1.);
    if (i < 4.5) return vec3(0., -1., 0.);
    return vec3(0., 1., 0.);
  }`;

const FRAG_PARS = `
  uniform sampler2D uPalette; uniform sampler2D uLampMap;
  uniform vec2 uSize; uniform float uNight; uniform float uTime; uniform vec3 uHorizon; uniform float uLit; uniform float uAlbedo;
  uniform vec4 uLandmarkFrames[6];
  uniform float uLandmarkCrownBases[6];
  uniform float uLandmarkSpireBases[6];
  varying vec3 vVox; varying vec3 vN; varying vec3 vFacadeN; varying float vAO; varying float vGz; flat varying int vPal;
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 gEmissive; float gRough; float gMetal;
  // Analytic coverage of a repeated rectangle; fade to its area average when subpixel.
  float facadeBox(vec2 p, vec2 period, vec2 lo, vec2 hi) {
    vec2 fw = max(fwidth(p), vec2(0.0001));
    vec2 q = mod(p, period);
    vec2 coverage = smoothstep(lo - fw, lo + fw, q) * (1.0 - smoothstep(hi - fw, hi + fw, q));
    float average = (hi.x - lo.x) * (hi.y - lo.y) / (period.x * period.y);
    return mix(coverage.x * coverage.y, average, smoothstep(0.3, 1.0, max(fw.x / period.x, fw.y / period.y)));
  }
  // A room (a window or a run of windows) at night: lit for about uLit of them, more or fewer by block, each always
  // the same (a fixed hash per room); warm 2700-3000 K lamps, a share cool of office LEDs
  vec3 roomLight(vec3 cell, vec2 room, float cool) {
    float habit = 0.55 + 0.9 * hash12(floor(cell.xz / 24.0) + 0.37);
    if (hash12(room) >= uLit * habit) return vec3(0.0);
    float r = hash12(room + 7.1);
    vec3 c = hash12(room + 2.9) < cool ? mix(vec3(0.84, 0.92, 1.0), vec3(0.96, 0.97, 0.95), r) : mix(vec3(1.0, 0.6, 0.3), vec3(1.0, 0.75, 0.48), r);
    return c * (0.55 + 0.35 * hash12(room + 3.3));
  }`;

const SURFACE = `
  vec4 pe = texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0);
  vec3 base = pow(pe.rgb, vec3(2.2));
  int m = int(pe.a * 255.0 + 0.5);
  vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
  float gz = vGz;
  float lvl = cell.y - gz;
  bool vert = abs(vN.y) < 0.5;
  float u = abs(vN.x) > 0.5 ? cell.z : cell.x;
  float wpos = abs(vN.x) > 0.5 ? cell.x : cell.z;
  float h = hash13(cell);
  gEmissive = vec3(0.); gRough = 0.88; gMetal = 0.0;
  vec3 col = base * (0.97 + 0.06 * h);
  bool shopLvl = lvl > 0.5 && lvl < 3.5;
  if (m == ${MAT.WALL}) {
    if (vert) {
      // Continuous coverage avoids binary floor/modulo edges breaking into pixel speckles.
      float along = abs(vN.x) > 0.5 ? vVox.z : vVox.x;
      float up = vVox.y - gz;
      float fy = max(fwidth(up), 0.0001);
      float shop = smoothstep(1.0 - fy, 1.0 + fy, up) * (1.0 - smoothstep(4.0 - fy, 4.0 + fy, up));
      float upperWin = facadeBox(vec2(along + 0.5, vVox.y - 0.5), vec2(2.0, 3.0), vec2(0.5), vec2(1.5, 2.5));
      float shopWin = facadeBox(vec2(along - 0.5, 1.5), vec2(5.0, 3.0), vec2(0.5, 0.0), vec2(4.5, 3.0));
      float win = mix(upperWin, shopWin, shop);
      vec3 glass = mix(base * 0.42, vec3(0.10, 0.13, 0.17), 0.55) + 0.025 * h;
      col = mix(col, glass, win);
      gRough = mix(gRough, 0.12, win); gMetal = 0.6 * win;
      vec2 room = vec2(floor(along / 4.0) + wpos * 17.31 + vN.x * 3.1, floor(vVox.y / 3.0) + vN.z * 5.7);
      vec3 shopLight = hash12(vec2(floor(along / 6.0), wpos * 3.7)) < 0.8 ? vec3(1.0, 0.78, 0.52) * 1.5 : vec3(0.0);
      gEmissive = mix(roomLight(cell, room, 0.15), shopLight, shop) * win * uNight;
    }
  } else if (m == ${MAT.CONCRETE}) {
    if (vert) {
      bool shop = lvl < 4.0 && lvl >= 1.0;
      bool win = shop && mod(u, 4.0) > 0.5;
      if (win) {
        col = mix(base * 0.42, vec3(0.10, 0.13, 0.17), 0.55) + 0.025 * h;
        gRough = 0.12; gMetal = 0.6;
        vec2 room = vec2(floor(u / 4.0) + wpos * 17.31 + vN.x * 3.1, floor(lvl / 3.0) + vN.z * 5.7);
        if (shop) {
          if (hash12(vec2(floor(u / 6.0), wpos * 3.7)) < 0.8) gEmissive = vec3(1.0, 0.78, 0.52) * 1.5 * uNight;
        } else {
          gEmissive = roomLight(cell, room, 0.15) * uNight;
        }
      }
    }
  } else if (m >= ${MAT.CITY_HALL} && m <= ${MAT.WILSHIRE}) {
    vec4 frame = uLandmarkFrames[m - ${MAT.CITY_HALL}];
    vec2 axis = vec2(cos(frame.w), sin(frame.w));
    vec2 crossAxis = vec2(-axis.y, axis.x);
    vec2 delta = vVox.xz - frame.xz;
    vec2 local = vec2(dot(delta, axis), dot(delta, crossAxis));
    // Select the tangent of the building's own facade, including voxel stair-step faces.
    bool acrossFace = abs(dot(vFacadeN.xz, axis)) > abs(dot(vFacadeN.xz, crossAxis));
    float along = acrossFace ? local.y : local.x;
    float depth = acrossFace ? local.x : local.y;
    // A facade side stays constant across the normal-coordinate jitter of voxel steps.
    float side = (acrossFace ? 1.0 : 2.0) * (depth < 0.0 ? -1.0 : 1.0);
    float up = vVox.y - frame.y;
    vec2 p = vec2(along, up);
    vec2 room = vec2(floor(along / 3.6) + side * 137.31, floor(up / 4.0));
    float opening = 0.0;
    float broadEye = 0.0;
    vec3 glazing = vec3(0.055, 0.075, 0.09);
    col = base * (0.985 + 0.03 * h);
    if (m == ${MAT.WILSHIRE} && up >= uLandmarkSpireBases[m - ${MAT.CITY_HALL}]) {
      // The measured mast is metal on every face, without curtain-wall rooms.
      col = vec3(0.28, 0.31, 0.33) * (0.985 + 0.03 * h);
      gRough = 0.5; gMetal = 0.45;
    } else if (m == ${MAT.DISNEY}) {
      // Unperforated stainless steel sails. Quiet panel joints preserve the massing.
      gRough = 0.38; gMetal = 0.72;
      if (vert) {
        float panel = facadeBox(p, vec2(3.0, 5.0), vec2(0.025), vec2(2.975, 4.975));
        col *= mix(0.87, 1.0, panel);
      }
      // LA Phil's night exterior shows grey steel catching soft white architectural
      // light, with warmer spill at its foot; the sails themselves remain opaque.
      float litFace = 0.65 + 0.35 * max(0.0, dot(normalize(vFacadeN), normalize(vec3(-0.4, 0.7, 0.6))));
      float steelWash = (0.12 + 0.22 * exp(-max(up, 0.0) / 38.0)) * litFace;
      gEmissive = base * (vec3(0.9, 0.94, 1.0) * steelWash
        + vec3(1.0, 0.77, 0.53) * 0.07 * exp(-max(up, 0.0) / 12.0)) * uNight;
    } else if (vert) {
      if (m == ${MAT.CITY_HALL}) {
        // Punched windows retain broad stone piers and solid floor spandrels.
        opening = facadeBox(p, vec2(3.6, 4.2), vec2(1.12, 0.95), vec2(2.48, 3.65));
        opening *= 1.0 - step(uLandmarkCrownBases[m - ${MAT.CITY_HALL}], up);
        float pier = facadeBox(p, vec2(3.6, 4.2), vec2(0.10, 0.0), vec2(0.38, 4.2));
        pier *= 1.0 - step(uLandmarkCrownBases[m - ${MAT.CITY_HALL}], up);
        col *= 1.0 - 0.065 * pier;
        room.y = floor(up / 4.2);
        gRough = 0.9;
      } else if (m == ${MAT.BROAD}) {
        // Arup's close-up: diagonal scooped GFRC lips with a dark upper throat,
        // rather than flat hexagonal holes. Module scale is estimated from the
        // architect's front elevation photograph, not fabrication measurements.
        float veilAlong = acrossFace ? -p.x : p.x;
        // Photo-guided Grand Avenue oculus: a depressed, stretched veil around
        // glazing, not an empty circular hole. Dimensions are approximate.
        float front = acrossFace && depth > 0.0 ? 1.0 : 0.0;
        vec2 eye = vec2((veilAlong + 4.8) / 5.8, (up - 11.5) / 4.5);
        eye.y += 0.10 * eye.x;
        float eyeRadius = length(eye);
        float depression = (1.0 - smoothstep(0.35, 1.35, eyeRadius)) * front;
        vec2 warped = vec2(veilAlong, up) + eye * vec2(1.4, 1.1) * depression;
        vec2 lattice = vec2(warped.x / 1.55 - 1.5 * warped.y / 1.45, warped.y / 1.45);
        vec2 q = fract(lattice) - 0.5;
        float scoopEdge = pow(q.x / 0.30, 2.0) + pow(q.y / 0.49, 2.0);
        float throatEdge = pow(q.x / 0.14, 2.0) + pow((q.y - 0.05) / 0.37, 2.0);
        float scoopAA = max(fwidth(scoopEdge), 0.001), throatAA = max(fwidth(throatEdge), 0.001);
        float fade = smoothstep(0.3, 0.85, max(fwidth(lattice.x), fwidth(lattice.y)));
        float scoop = (1.0 - smoothstep(1.0 - scoopAA, 1.0 + scoopAA, scoopEdge)) * (1.0 - fade);
        opening = mix(1.0 - smoothstep(1.0 - throatAA, 1.0 + throatAA, throatEdge), 0.16, fade);
        float bowlShade = mix(0.08, 0.48, smoothstep(-0.3, 0.35, q.x));
        col *= mix(1.0 - scoop * bowlShade, 0.94, fade);
        col *= 1.0 - depression * (0.32 + 0.28 * smoothstep(-0.4, 0.6, eye.y));
        float eyeAA = max(fwidth(eyeRadius), 0.012);
        broadEye = (1.0 - smoothstep(0.53 - eyeAA, 0.53 + eyeAA, eyeRadius)) * front;
        // A narrow mullion survives across the recessed glazing.
        float mullion = 1.0 - smoothstep(0.03, 0.075, abs(eye.x + 0.09 * eye.y));
        opening = mix(opening, 0.98 - 0.12 * mullion, broadEye);
        glazing = vec3(0.075, 0.085, 0.088);
        gRough = 0.94;
      } else if (m == ${MAT.MISSION}) {
        // Restrained tall openings with a round arch; stucco stays dominant.
        vec2 q = mod(p, vec2(6.0, 7.0));
        vec2 fw = max(fwidth(p), vec2(0.001));
        float archTop = 4.35 + sqrt(max(0.0, 1.1 * 1.1 - (q.x - 3.0) * (q.x - 3.0)));
        opening = facadeBox(p, vec2(6.0, 7.0), vec2(1.9, 1.0), vec2(4.1, 5.45));
        opening *= 1.0 - smoothstep(archTop - fw.y, archTop + fw.y, q.y);
        float fade = smoothstep(0.5, 1.6, max(fw.x, fw.y));
        opening = mix(opening, 0.22, fade);
        room = vec2(floor(along / 6.0) + side * 137.31, floor(up / 7.0));
        glazing = vec3(0.065, 0.052, 0.037);
        gRough = 0.96;
      } else if (m == ${MAT.US_BANK}) {
        opening = facadeBox(p, vec2(2.8, 4.0), vec2(0.45, 0.32), vec2(2.35, 3.82));
        glazing = mix(base * 0.30, vec3(0.10, 0.16, 0.19), 0.7);
        room.x = floor(along / 2.8) + side * 137.31;
        gRough = 0.72;
      } else {
        // Fine blue-grey curtain wall mullions, with darker floor spandrels.
        opening = facadeBox(p, vec2(1.55, 4.1), vec2(0.055, 0.32), vec2(1.495, 4.00));
        glazing = mix(base * 0.65, vec3(0.08, 0.15, 0.21), 0.5);
        col = base * 0.65;
        room = vec2(floor(along / 4.65) + side * 137.31, floor(up / 4.1));
        gRough = 0.5;
      }
      col = mix(col, glazing, opening);
      gRough = mix(gRough, m == ${MAT.BROAD} ? 0.65 : 0.20, opening);
      gMetal = opening * (m == ${MAT.BROAD} ? 0.08 : 0.38);
      if (m == ${MAT.BROAD}) {
        // Tillotson's photograph has a softly white floodlit veil and a continuous
        // gallery-lit zone behind it, with most deep throats remaining dark.
        float wash = 0.22 + 0.50 * exp(-max(up, 0.0) / 26.0);
        float gallery = smoothstep(11.0, 14.0, up) * (1.0 - smoothstep(20.0, 23.0, up));
        gEmissive = (col * vec3(1.0, 0.98, 0.93) * wash
          + vec3(0.92, 0.95, 1.0) * (0.018 + 0.15 * gallery) * opening) * uNight;
        gEmissive += vec3(1.0, 0.91, 0.77) * broadEye * 0.09 * uNight;
      } else {
        float strength = m == ${MAT.MISSION} ? 0.4 : 0.65;
        gEmissive = roomLight(frame.xyz, room, m >= ${MAT.US_BANK} ? 0.6 : 0.15) * opening * uNight * strength;
      }
    }
  } else if (m == ${MAT.STUCCO}) {
    // painted stucco: a window every 3 m on 3.5 m floors, 1.6 x 2.3 m (35 % of the face) and set deep in the wall
    // (its reveal shades the top and one side); drawn per pixel, not per voxel, and faded to its average far away
    gRough = 0.96;
    col = base * (0.95 + 0.07 * h);
    if (vert) {
      float along = abs(vN.x) > 0.5 ? vVox.z : vVox.x, up = vVox.y - gz;
      vec2 p = vec2(along, up), fw = max(fwidth(p), vec2(1e-4));
      bool ground = up < 3.5;
      vec2 period = vec2(3.0, 3.5), lo = ground ? vec2(0.35, 0.35) : vec2(0.7, 0.9), hi = ground ? vec2(2.65, 2.9) : vec2(2.3, 3.2);
      vec2 q = mod(p, period);
      vec2 inside = smoothstep(lo - fw, lo + fw, q) * (1.0 - smoothstep(hi - fw, hi + fw, q));
      float far = smoothstep(0.35, 1.1, max(fw.x, fw.y));
      float win = mix(inside.x * inside.y, ground ? 0.55 : 0.35, far);
      float reveal = (step(hi.y - 0.28, q.y) + step(q.x, lo.x + 0.18) * 0.6) * (1.0 - far);
      float sill = (1.0 - far) * step(lo.y - 0.12, q.y) * step(q.y, lo.y) * step(lo.x - 0.1, q.x) * step(q.x, hi.x + 0.1);
      vec3 glass = mix(base * 0.3, vec3(0.07, 0.09, 0.12), 0.65) * (1.0 - 0.45 * min(reveal, 1.0));
      col = mix(col * (1.0 + 0.12 * sill), glass, win);
      gRough = mix(gRough, 0.2, win); gMetal = 0.45 * win;
      vec2 room = vec2(floor(along / 3.0) + wpos * 17.31 + vN.x * 3.1, floor(up / 3.5) + vN.z * 5.7);
      vec3 light = ground ? (hash12(room + 1.7) < 0.7 ? vec3(1.0, 0.76, 0.5) * 1.3 : vec3(0.0)) : roomLight(cell, room, 0.1);
      gEmissive = light * win * (1.0 - 0.5 * min(reveal, 1.0)) * uNight;
    }
  } else if (m == ${MAT.DISNEY_GLASS}) {
    // Authored glazing geometry defines these openings; no invented office grid.
    col = base * (0.72 + 0.04 * h);
    gRough = 0.16; gMetal = 0.22;
    gEmissive = vec3(1.0, 0.68, 0.36) * 0.8 * uNight;
  } else if (m == ${MAT.GLASS}) {
    if (vert) {
      if (mod(lvl, 4.0) < 0.5) { col = base * 0.55 + 0.04; gRough = 0.5; }
      else {
        col = base * (0.8 + 0.12 * step(0.5, mod(u, 2.0)));
        gRough = 0.08; gMetal = mix(0.35, 0.6, uNight);
        vec2 zone = vec2(floor(u / 6.0) + wpos * 13.7 + vN.x * 2.3, floor(lvl / 4.0) + vN.z * 4.1);
        if (shopLvl && lvl < 4.0) gEmissive = vec3(1.0, 0.84, 0.64) * 1.3 * uNight;
        else gEmissive = roomLight(cell, zone, 0.6) * 1.2 * uNight;
      }
    } else { gRough = 0.3; gMetal = 0.4; }
  } else if (m == ${MAT.CLASSIC}) {
    gRough = 0.8;
    if (vert && lvl < 7.5) col *= mod(lvl, 2.0) < 1.0 ? 0.9 : 1.0;
  } else if (m == ${MAT.RIBBON}) {
    // World-height floors remain level across sloping terrain beneath one tower.
    gRough = 0.75; gMetal = 0.0;
    if (vert) {
      float win = facadeBox(vec2(1.0, vVox.y - 0.8), vec2(2.0, 4.0), vec2(0.0, 0.8), vec2(2.0, 3.2));
      vec3 glass = mix(base * 0.4, vec3(0.12, 0.16, 0.2), 0.6) + 0.02 * h;
      col = mix(col, glass, win);
      gRough = mix(gRough, 0.08, win); gMetal = 0.55 * win;
      vec2 zone = vec2(floor(u / 12.0) + wpos * 13.7 + vN.x * 2.3, floor(vVox.y / 4.0) + vN.z * 4.1);
      gEmissive = roomLight(cell, zone, 0.5) * win * uNight;
    }
  } else if (m == ${MAT.WINDOW}) {
    gRough = 0.15; gMetal = 0.35;
    col *= 0.6;
    gEmissive = roomLight(cell, floor(cell.xz / 2.0) + floor(cell.y / 2.0) * 7.3, 0.3) * uNight;
  } else if (m == ${MAT.LEAF}) {
    col = base * vec3(0.97, 0.97, 0.86) * (0.8 + 0.35 * h); gRough = 0.95; // evergreen, a little dusty
  } else if (m == ${MAT.GRASS}) {
    col = base * (0.88 + 0.2 * h); gRough = 1.0;
  } else if (m == ${MAT.WATER}) {
    // the LA River: a thin, shallow green-grey sheet in a concrete channel, more murky than mirror
    float r = sin(cell.x * 0.9 + uTime * 1.3) * sin(cell.z * 1.1 - uTime) * 0.5 + 0.5;
    col = mix(vec3(0.07, 0.12, 0.095), vec3(0.15, 0.22, 0.17), r * r) * (0.94 + 0.12 * h); gRough = 0.22; gMetal = 0.12;
    vec3 V = normalize(cameraPosition - vVox);
    float fres = 1.0 - clamp(dot(vN, V), 0.0, 1.0); fres *= fres; fres *= fres;
    col = mix(col, uHorizon * 0.7, clamp(0.05 + 0.3 * fres, 0.0, 0.3));
    if (vN.y > 0.5 && hash12(cell.xz * 0.37 + floor(uTime * 1.7 + h * 9.0)) < 0.004) col += vec3(0.3, 0.32, 0.26) * (1.0 - uNight) * (1.0 - uNight);
  } else if (m == ${MAT.LAMP}) {
    col = base; gEmissive = vec3(1.0, 0.8, 0.55) * (0.15 + 3.2 * uNight);
  } else if (m == ${MAT.METAL}) {
    gRough = 0.4; gMetal = 0.5;
    if (base.r > 0.3 && base.r > base.b * 2.0) gEmissive = base * 1.2 * uNight;
  } else if (m == ${MAT.SOIL}) {
    col = base * (mod(cell.y, 5.0) < 1.0 ? 0.82 : 1.0) * (0.9 + 0.2 * h); gRough = 1.0;
  } else if (m == ${MAT.CAR}) {
    gRough = 0.25; gMetal = 0.3;
    if (uNight > 0.0 && vert && lvl < 1.0) gEmissive = mix(vec3(1.0, 0.12, 0.08), vec3(1.0, 0.95, 0.85), step(0.5, h)) * 1.4 * uNight * step(0.55, fract(h * 7.0));
  } else if (m == ${MAT.BRONZE}) {
    if (vert) {
      if (mod(lvl, 4.0) < 0.5) { col = vec3(0.025, 0.024, 0.022); gRough = 0.5; }
      else if (mod(u, 3.0) < 0.5) {
        col = vec3(0.16, 0.12, 0.065); gRough = 0.55; gMetal = 0.25;
        gEmissive = vec3(1.0, 0.75, 0.4) * 0.35 * uNight;
      } else {
        col = base * 0.6; gRough = 0.06; gMetal = 0.5;
        if (hash12(vec2(floor(u / 2.0) + cell.x * 0.17, floor(lvl / 4.0))) > 0.6) gEmissive = vec3(1.0, 0.85, 0.6) * 0.5 * uNight;
      }
    }
  } else if (m == ${MAT.SIGNBAND}) {
    col = base; gRough = 0.35; gMetal = 0.7;
  } else if (m == ${MAT.SIGN}) {
    col = base; gRough = 0.3; gMetal = 0.6;
    gEmissive = base * (0.15 + 2.2 * uNight);
  } else if (m == ${MAT.MARK}) {
    col = base * (0.95 + 0.05 * h);
  }
  if (uNight > 0.0) { // street lamps light what is near the ground; water reflects them instead
    vec3 lm = texture2D(uLampMap, vVox.xz / uSize).rgb;
    float fall = clamp(1.0 - (vVox.y - gz) / 16.0, 0.0, 1.0);
    float under = m == ${MAT.LEAF} ? (vN.y < -0.5 ? 2.6 : 1.7) : 1.0;
    if (m == ${MAT.WATER}) gEmissive += lm * vec3(1.0, 0.72, 0.42) * fall * uNight * 0.45;
    else gEmissive += col * lm * fall * uNight * 2.2 * under;
  }
  if (m != ${MAT.LAMP} && m != ${MAT.SIGN}) col *= mix(1.0, uAlbedo, smoothstep(0.2, 0.6, dot(col, vec3(0.2126, 0.7152, 0.0722))));
  diffuseColor.rgb = col * mix(0.62, 1.0, vAO);`;

// MeshStandardMaterial with the voxel surface: colour, roughness, metalness and emission per material id
export function makeVoxelMaterial(uniforms: VoxelUniforms, packed = true) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${packed ? QUAD_PARS : 'attribute vec3 vattr; attribute float vpal;'}
        varying vec3 vVox; varying vec3 vN; varying vec3 vFacadeN; varying float vAO; varying float vGz; flat varying int vPal;
        ${NORMAL_FROM_IDX}`)
      // vattr.x = face axis (0-5) + 8 x the wall's direction in plan (mesher.worker.ts): a staircase wall is lit as its plane
      .replace('#include <beginnormal_vertex>', `${packed ? `vec3 vattr = vec3(float(uint(qFlags.x)&255u),float((uint(qFlags.y)>>(uint(position.x)*2u))&3u),float(uint(qFlags.x)>>8u)); float vpal = qPal;` : ''}
        float nAx = mod(vattr.x, 8.0), nAng = floor(vattr.x / 8.0 + 0.01);
        vec3 objectNormal = nAng > 0.5 ? vec3(cos((nAng - 1.0) * 0.261799), 0., sin((nAng - 1.0) * 0.261799)) : normalFromIdx(nAx);`)
      // and its 1 m steps don't shade each other: shadow lookups step out further along the wall's true direction
      .replace('#include <shadowmap_vertex>', THREE.ShaderChunk.shadowmap_vertex.replace(
        'directionalLightShadows[ i ].shadowNormalBias', '(directionalLightShadows[ i ].shadowNormalBias * (nAng > 0.5 ? 3.0 : 1.0))'))
      .replace('#include <begin_vertex>', `vec3 transformed = ${packed ? 'quadPosition()' : 'position'};
        vVox = (modelMatrix * vec4(transformed,1.0)).xyz; vN = normalFromIdx(nAx); vFacadeN = objectNormal; vAO = vattr.y / 3.0; vGz = vattr.z; vPal = int(vpal + 0.5);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += gEmissive;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float aoF = mix(0.55, 1.0, vAO);
        reflectedLight.indirectDiffuse *= aoF; reflectedLight.indirectSpecular *= aoF;`);
  };
  mat.customProgramCacheKey = () => packed ? 'voxel-quad-v1' : 'voxel-expanded-v1';
  return mat;
}
