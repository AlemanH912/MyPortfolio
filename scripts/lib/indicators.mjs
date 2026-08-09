// RSI de Wilder, compartido entre las distintas alertas.
export function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) {
    throw new Error(`Se necesitan al menos ${period + 1} cierres, llegaron ${closes.length}`);
  }
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Momentum Oscillator clásico: close actual vs. close de hace `period` barras.
export function computeMomentum(closes, period = 10) {
  const momentum = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    momentum[i] = closes[i] - closes[i - period];
  }
  return momentum;
}

export function findPivotHighs(values, lookback = 3) {
  const pivots = [];
  for (let i = lookback; i < values.length - lookback; i++) {
    if (values[i] == null) continue;
    let isPivot = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (values[k] == null || values[k] > values[i]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push(i);
  }
  return pivots;
}

export function findPivotLows(values, lookback = 3) {
  const pivots = [];
  for (let i = lookback; i < values.length - lookback; i++) {
    if (values[i] == null) continue;
    let isPivot = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (values[k] == null || values[k] < values[i]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push(i);
  }
  return pivots;
}

// Divergencia clásica de Momentum: compara los últimos dos pivotes de
// PRECIO (máximos para bajista, mínimos para alcista) contra el valor del
// oscilador de momentum en esos mismos puntos.
//   Bajista: precio hace un máximo más alto, pero el momentum en ese punto
//            es más débil que en el máximo anterior (impulso agotándose).
//   Alcista: precio hace un mínimo más bajo, pero el momentum en ese punto
//            es más fuerte que en el mínimo anterior (venta agotándose).
export function detectDivergence(closes, momentum, pivotLookback = 3) {
  const priceHighs = findPivotHighs(closes, pivotLookback).filter((i) => momentum[i] != null);
  const priceLows = findPivotLows(closes, pivotLookback).filter((i) => momentum[i] != null);

  let bearish = null;
  if (priceHighs.length >= 2) {
    const i1 = priceHighs[priceHighs.length - 2];
    const i2 = priceHighs[priceHighs.length - 1];
    if (closes[i2] > closes[i1] && momentum[i2] < momentum[i1]) {
      bearish = { i1, i2 };
    }
  }

  let bullish = null;
  if (priceLows.length >= 2) {
    const i1 = priceLows[priceLows.length - 2];
    const i2 = priceLows[priceLows.length - 1];
    if (closes[i2] < closes[i1] && momentum[i2] > momentum[i1]) {
      bullish = { i1, i2 };
    }
  }

  return { bearish, bullish };
}
