/** Усреднённая CTR-кривая органической выдачи Яндекса по позициям (топ-30). */
const CTR: Record<number, number> = {
  1: 0.28, 2: 0.16, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.05, 7: 0.04, 8: 0.032, 9: 0.028, 10: 0.025,
};

export function ctrForPosition(pos: number): number {
  if (pos <= 0) return 0;
  if (CTR[pos] != null) return CTR[pos];
  if (pos <= 20) return 0.012; // 11–20
  if (pos <= 30) return 0.006; // 21–30
  return 0.002;
}

/** Прогноз трафика: частотность × CTR(целевая позиция). */
export function estimateTraffic(frequency: number, targetPosition: number): number {
  return Math.round(frequency * ctrForPosition(targetPosition));
}
