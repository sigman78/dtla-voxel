export type Vec3Tuple = [number, number, number];

export interface View {
  label: string;
  pos: Vec3Tuple;
  target: Vec3Tuple;
  ms?: number;
}

export interface Facts {
  name: string;
  kind: string;
  en?: string;
  height?: number;
  year?: number;
  by?: string;
  far?: number;
}

// x = column (east along the grid), y = row (south along the grid), z = top in metres above meta.base;
// g (ground under it) and R (footprint radius) are optional
export interface Label extends Facts {
  alt?: string;
  x: number;
  y: number;
  z: number;
  g?: number;
  R?: number;
}

export interface TileLevel {
  s: number;
  nx: number;
  ny: number;
}

export interface Meta {
  W: number;
  D: number;
  H: number;
  base: number;
  theta_deg: number;
  crs?: string;
  center?: [number, number];
  tiles: { N: number; levels: TileLevel[]; bytes?: number };
  palette: [number, number, number, number][];
  // Facade frames in voxel coordinates: x, height, z; angle is radians in plan.
  landmarkStyles?: { key: string; material: number; origin: Vec3Tuple; angle: number; crownBase?: number; spireBase?: number }[];
  obstructionLights?: { building: string; osmType: string; osmId: number; position: Vec3Tuple; kind: 'beacon' | 'steady'; phase: number }[];
  lamps: [number, number, number][];
  labels: Label[];
  views: Record<string, View>;
  sources: Record<string, string>;
}

export interface ColumnData {
  s: number;
  x0: number;
  y0: number;
  S: number;
  ground: Uint8Array;
  runs: Uint16Array;
  off: Uint32Array;
}
