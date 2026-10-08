// Deterministic indicators. Every function reads data at index <= i only —
// look-ahead safety is structural: no function accepts future bars.
export function sma(values: number[], n: number, i: number): number | null {
  if (n <= 0 || i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += values[k]!;
  return s / n;
}

export function roc(values: number[], n: number, i: number): number | null {
  if (n <= 0 || i < n || values[i - n] === 0) return null;
  return (values[i]! - values[i - n]!) / Math.abs(values[i - n]!);
}

export function stdevLogReturns(values: number[], n: number, i: number): number | null {
  if (n < 2 || i < n) return null;
  const rets: number[] = [];
  for (let k = i - n + 1; k <= i; k++) {
    if (values[k - 1]! <= 0 || values[k]! <= 0) return null;
    rets.push(Math.log(values[k]! / values[k - 1]!));
  }
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1));
}

export function donchian(values: number[], n: number, i: number): { high: number; low: number } | null {
  if (n <= 0 || i < n - 1) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    if (values[k]! > high) high = values[k]!;
    if (values[k]! < low) low = values[k]!;
  }
  return { high, low };
}

export function stdevPrices(values: number[], n: number, i: number): number | null {
  if (n < 2 || i < n - 1) return null;
  const slice = values.slice(i - n + 1, i + 1);
  const mean = slice.reduce((s, v) => s + v, 0) / n;
  return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
}

export function zscore(values: number[], n: number, i: number): number | null {
  const m = sma(values, n, i);
  const sd = stdevPrices(values, n, i);
  if (m === null || sd === null || sd === 0) return null;
  return (values[i]! - m) / sd;
}
