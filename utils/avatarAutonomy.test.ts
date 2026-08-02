import { describe, expect, it } from 'vitest';
import { AvatarAutonomy, type AvatarActivity, type AvatarAttentionPointer } from './avatarAutonomy';
import { DEFAULT_AVATAR_PERFORMANCE, type AvatarPerformanceDirection } from './avatarPerformance';

const seededRandom = (seed = 0x12345678) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const noPointer: AvatarAttentionPointer = { x: 0, y: 0, active: false, lastMoved: 0 };

const run = (
  autonomy: AvatarAutonomy,
  duration: number,
  direction: AvatarPerformanceDirection = DEFAULT_AVATAR_PERFORMANCE,
  activity: AvatarActivity = 'idle',
  pointer: AvatarAttentionPointer = noPointer,
) => {
  const frames = [];
  for (let now = 0; now <= duration; now += 16) frames.push(autonomy.step(now, direction, activity, pointer));
  return frames;
};

describe('AvatarAutonomy', () => {
  it('keeps choosing visible poses and blinking without LLM updates', () => {
    const frames = run(new AvatarAutonomy(0, seededRandom(7)), 10_000);
    const poses = new Set(frames.map(frame => frame.pose));

    expect(poses.size).toBeGreaterThan(1);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headX)))).toBeGreaterThan(0.08);
    expect(Math.max(...frames.map(frame => Math.abs(frame.eyeX)))).toBeGreaterThan(0.08);
    expect(Math.max(...frames.map(frame => frame.blink))).toBeGreaterThan(0.75);
  });

  it('lets eyes follow a fresh pointer more strongly than the head', () => {
    const performer = new AvatarAutonomy(0, seededRandom(12));
    const pointer = { x: 0.9, y: 0.25, active: true, lastMoved: 0 };
    const frames = run(performer, 1_600, DEFAULT_AVATAR_PERFORMANCE, 'idle', pointer);
    const frame = frames[frames.length - 1]!;

    expect(frame.eyeX).toBeGreaterThan(0.55);
    expect(frame.eyeX).toBeGreaterThan(frame.headX * 1.7);
    expect(frame.pose).toBe('pointer');
  });

  it('looks down while thinking and creates non-periodic emphasis while speaking', () => {
    const thinkingFrames = run(new AvatarAutonomy(0, seededRandom(23)), 1_800, DEFAULT_AVATAR_PERFORMANCE, 'thinking');
    const thinking = thinkingFrames[thinkingFrames.length - 1]!;
    const speaking = run(new AvatarAutonomy(0, seededRandom(29)), 5_000, DEFAULT_AVATAR_PERFORMANCE, 'speaking');

    expect(thinking.eyeY).toBeLessThan(-0.25);
    expect(thinking.headY).toBeLessThan(0);
    expect(Math.max(...speaking.map(frame => frame.speechAccent))).toBeGreaterThan(0.5);
    expect(Math.max(...speaking.map(frame => frame.gestureEnvelope))).toBeGreaterThan(0.5);
  });

  it('turns a close camera direction into a physical lean with attack and release', () => {
    const closeDirection: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'tilt',
      camera: 'push-in',
      intensity: 0.9,
    };
    const frames = run(new AvatarAutonomy(0, seededRandom(31)), 2_000, closeDirection, 'speaking');

    expect(Math.max(...frames.map(frame => frame.lean))).toBeGreaterThan(0.035);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headZ)))).toBeGreaterThan(0.08);
  });

  it('turns a real audio onset into synchronized head and hand emphasis', () => {
    const performer = new AvatarAutonomy(0, seededRandom(41));
    const frames = [];
    for (let now = 0; now <= 520; now += 16) {
      const energy = now < 96 ? 0.04 : now < 240 ? 0.92 : 0.12;
      frames.push(performer.step(now, DEFAULT_AVATAR_PERFORMANCE, 'speaking', noPointer, energy));
    }

    expect(Math.max(...frames.map(frame => frame.speechAccent))).toBeGreaterThan(0.72);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headY)))).toBeGreaterThan(0.03);
  });
  it('uses a fast touch attack without speeding up ambient call motion', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'tilt',
      intensity: 0.9,
    };
    const ambient = new AvatarAutonomy(0, seededRandom(53));
    const touched = new AvatarAutonomy(0, seededRandom(53));

    touched.triggerTouchReaction(direction, 'speaking', 0);
    ambient.step(0, direction, 'speaking', noPointer);
    touched.step(0, direction, 'speaking', noPointer);
    const ambientAttack = ambient.step(96, direction, 'speaking', noPointer);
    const touchAttack = touched.step(96, direction, 'speaking', noPointer);

    expect(touchAttack.gestureEnvelope).toBeGreaterThan(ambientAttack.gestureEnvelope + 0.4);
    expect(touched.step(1_500, direction, 'speaking', noPointer).gestureEnvelope).toBe(0);
    expect(ambient.step(1_500, direction, 'speaking', noPointer).gestureEnvelope).toBeGreaterThan(0.5);
  });
});
