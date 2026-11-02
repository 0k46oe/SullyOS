import type { CSSProperties } from 'react';

// UI chrome only. Fallbacks preserve the original appearance when the paper
// palette variables are absent. Never apply this to user CSS or room artwork.
const tones: Record<string, string> = {};
const groups: Record<string, string[]> = {
  'green-soft': ['faf5ff','f5f3ff','f3f0ff','f3f0fa','f8f7ff','f8f6ff','faf9ff','ede9fe','eef2ff','e0e7ff','eff6ff','dbeafe','ecfdf5','f0fdf4','f0fdfa','f0f9ff','fff1f7','fce7f3','241b3f','171130','120d24','3a3060','1c1634','2b2150'],
  'green-line': ['ddd6fe','e9d5ff','c4b5fd','e9e5ff','c7d2fe','a5b4fc','bfdbfe','bae6fd','bbf7d0','86efac','99f6e4','f1d5e4','f5d0e3','e9a8c7','f4a3ca','8f9bf4','f4b78f','a78bda'],
  'green-ink': ['1f1147','4c1d95','581c87','5b21b6','6d28d9','7c3aed','8b5cf6','a78bfa','715588','6366f1','4338ca','4f46e5','3730a3','1e40af','1e3a8a','2563eb','1d4ed8','3b82f6','0369a1','0ea5e9','16a34a','15803d','166534','22c55e','10b981','0f766e','115e59','14b8a6','db2777','ec4899','be185d','9d174d','f472b6','6b4b64'],
  'yellow': ['fef3c7','fde68a','fffbeb','fefce8','fcd34d','fff7ed','fed7aa','fbbf24'],
  'yellow-ink': ['92400e','f59e0b','d97706','b45309','78350f','a16207','f97316','9a3412'],
  'surface': ['ffffff','fffefe'],
  'paper': ['f3f4f6','f9fafb','f8fafc','f1f5f9','fafafa','f5f7ff','fafbff','f3f4f8','f5f6fa'],
  'line': ['e5e7eb','e2e8f0','cbd5e1','d1d5db'],
  'ink': ['1f2937','334155','374151','475569','4b5563','0f172a'],
  'muted': ['6b7280','64748b','9ca3af','94a3b8','78716c'],
};
for (const [tone, colors] of Object.entries(groups)) for (const color of colors) tones[color] = tone;

function mappedColor(original: string, rgb: number[], alpha?: number): string {
  const hex = rgb.map(value => value.toString(16).padStart(2, '0')).join('');
  const tone = tones[hex];
  if (!tone) return original; // Real warning/error colors keep their meaning.
  return alpha === undefined
    ? 'var(--sp-' + tone + ', ' + original + ')'
    : 'rgba(var(--sp-' + tone + '-rgb, ' + rgb.join(', ') + '), ' + alpha + ')';
}

function mapColors(value: string, surface = false): string {
  if (/url\(/i.test(value)) return value;
  const mapped = value.replace(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b|rgba?\([\d.,\s]+\)/gi, original => {
    if (original[0] === '#') {
      let hex = original.slice(1);
      if (hex.length < 5) hex = [...hex].map(char => char + char).join('');
      const rgb = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
      return mappedColor(original, rgb, hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : undefined);
    }
    const channels = original.match(/[\d.]+/g)!.map(Number);
    return mappedColor(original, channels.slice(0, 3), channels[3]);
  });
  return surface ? mapped.replace(/--sp-green-ink/g, '--sp-green-soft').replace(/--sp-yellow-ink/g, '--sp-yellow') : mapped;
}

/** Use on memory UI style objects, including assembled gradients and alpha colors. */
export function paperStyle<T extends CSSProperties>(style: T): T {
  const result = { ...style };
  for (const key of Object.keys(result) as (keyof T)[]) {
    const value = result[key];
    if (typeof value === 'string' && /color|background|border|shadow|outline|fill|stroke/i.test(String(key))) {
      const surface = /background/i.test(String(key)) && style.backgroundClip !== 'text' && style.WebkitBackgroundClip !== 'text';
      result[key] = mapColors(value, surface) as T[keyof T];
    }
  }
  const background = String(result.background || result.backgroundColor || '');
  if (/--sp-(green-soft|yellow)[,\-]/.test(background) && /^(#fff(?:fff)?|white)$/i.test(String(style.color))) {
    result.color = 'var(--sp-green-ink, ' + style.color + ')';
  }
  return result;
}
