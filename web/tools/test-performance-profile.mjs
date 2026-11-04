import assert from 'node:assert/strict';
import { BALANCED_PROFILE as balanced, MOBILE_PROFILE as mobile, resolvePerformanceProfile as resolve } from '../src/performanceProfile.ts';
const query = value => new URLSearchParams(value);
assert.equal(resolve(query(''), false), balanced);
assert.equal(resolve(query(''), true), mobile);
assert.equal(resolve(query('performance=balanced'), true), balanced);
assert.equal(resolve(query('performance=mobile'), false), mobile);
assert.equal(resolve(query('performance=unknown'), true), mobile);
assert.equal(resolve(query('shadowlod=bad'), false), balanced);
const override = resolve(query('performance=mobile&shadowlod=2'), false);
assert.equal(override.name, 'mobile');
assert.equal(override.shadows.minimumLevel, 2);
assert.equal(override.lod.maxBytes, 64 * 1024 ** 2);
assert.equal(balanced.shadows.minimumLevel, 4, 'overrides must not mutate shared presets');
for (const profile of [balanced, mobile, override]) {
  assert(Object.isFrozen(profile));
  for (const section of ['rendering', 'lod', 'streaming', 'shadows']) assert(Object.isFrozen(profile[section]));
  assert(profile.lod.retainPixels < profile.lod.upgradePixels);
  assert(profile.shadows.nearEnterDistance < profile.shadows.nearExitDistance);
  assert(profile.streaming.residentBytes > profile.lod.maxBytes);
}
assert.throws(() => { override.shadows.minimumLevel = 8; }, TypeError);
console.log('Passed: automatic/explicit profiles, diagnostic precedence, fallback, immutable independent settings');
