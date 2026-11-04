// Viewer policy, resolved once before renderer/streamer construction. Distances
// are metres, durations milliseconds, budgets bytes, and LOD thresholds pixels.
// Reload after changing profiles: live mutation would bypass shadow/LOD caches.
const MiB = 1024 * 1024;
const defaults = Object.freeze({
  name: 'balanced',
  rendering: Object.freeze({ maxPixelRatio: 2 }),
  lod: Object.freeze({
    minimumLevel: 1, screenSpaceScale: 1, maxLeaves: 384, maxBytes: 128 * MiB,
    upgradePixels: 2, retainPixels: 1.5, retainedPriority: 1.3,
    upgradeDelayMs: 400, nearDistance: 192,
    offscreenShadowMaxScore: 2.5, offscreenShadowScale: 0.5,
  }),
  streaming: Object.freeze({
    selectionIntervalMs: 100, loadingCaptionDelayMs: 800,
    residentBytes: 192 * MiB, cacheGraceMs: 30000,
    pressureDelayMs: 2000, pressureMultiplier: 1.15, maxPressure: 4,
    uploadBytesPerFrame: 2 * MiB, pendingReplyBytes: 4 * MiB, maxWorkers: 4, reservedCores: 2,
  }),
  shadows: Object.freeze({
    minimumLevel: 4, nearEnterDistance: 192, nearExitDistance: 256,
    mapSize: 8192, filterRadius: 3,
    viewScale: 1.15, minimumRadius: 300, maximumMapFraction: 0.75,
    coveragePadding: 1.1, refitShrinkRatio: 0.75, radiusQuantum: 32, snapTexels: 8,
    normalBiasTexelScale: 0.3, normalBiasMin: 0.02, normalBiasMax: 0.25,
    depthBiasTexelScale: 0.25, depthBiasMin: 0.02, depthBiasMax: 0.15,
    minimumSunElevation: 0.05, angledWallBiasMultiplier: 3,
  }),
});

type Widen<T> = T extends number ? number : T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };
export type ViewerPerformanceProfile = Widen<typeof defaults>;
export const BALANCED_PROFILE: ViewerPerformanceProfile = defaults;

// Preserve the existing small-touch-screen policy; this is not a new GPU tier
// or a claim that every mobile device needs the same settings.
export const MOBILE_PROFILE: ViewerPerformanceProfile = Object.freeze({
  ...BALANCED_PROFILE, name: 'mobile',
  lod: Object.freeze({ ...BALANCED_PROFILE.lod, minimumLevel: 4, maxLeaves: 192, maxBytes: 64 * MiB }),
  streaming: Object.freeze({ ...BALANCED_PROFILE.streaming, residentBytes: 96 * MiB }),
});

export function resolvePerformanceProfile(query: URLSearchParams, smallTouchScreen: boolean): ViewerPerformanceProfile {
  const requested = query.get('performance');
  const base = requested === 'balanced' ? BALANCED_PROFILE
    : requested === 'mobile' ? MOBILE_PROFILE
    : smallTouchScreen ? MOBILE_PROFILE : BALANCED_PROFILE;
  // Existing diagnostic URL takes precedence over the selected preset.
  const shadowLevel = Number(query.get('shadowlod'));
  return [1, 2, 4, 8].includes(shadowLevel)
    ? Object.freeze({ ...base, shadows: Object.freeze({ ...base.shadows, minimumLevel: shadowLevel }) })
    : base;
}
