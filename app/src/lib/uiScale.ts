/**
 * 全站字体缩放档位。
 *
 * 15 级：75% 起、150% 封顶，100% 为「正常」。设置页的滑块按索引移动，
 * 具体百分比由这里统一给出，避免界面与持久化各写一套换算。
 */
export const FONT_SCALE_LEVELS = [
  75, 80, 85, 90, 95,
  100, 105, 110, 115, 120,
  125, 130, 135, 140, 150,
] as const;

export const FONT_SCALE_MIN = FONT_SCALE_LEVELS[0];
export const FONT_SCALE_MAX = FONT_SCALE_LEVELS[FONT_SCALE_LEVELS.length - 1];
export const FONT_SCALE_DEFAULT = 100;

/** 把任意来源（旧 localStorage / 手填）的值收敛到最接近的合法档位。 */
export function normalizeFontScale(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return FONT_SCALE_DEFAULT;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, numeric));
  let closest = FONT_SCALE_DEFAULT;
  let distance = Number.POSITIVE_INFINITY;
  for (const level of FONT_SCALE_LEVELS) {
    const nextDistance = Math.abs(level - clamped);
    if (nextDistance < distance) {
      distance = nextDistance;
      closest = level;
    }
  }
  return closest;
}

/** 当前百分比对应的滑块索引（0–14）。 */
export function fontScaleToIndex(value: number): number {
  const index = FONT_SCALE_LEVELS.indexOf(normalizeFontScale(value) as typeof FONT_SCALE_LEVELS[number]);
  return index >= 0 ? index : FONT_SCALE_LEVELS.indexOf(FONT_SCALE_DEFAULT);
}
