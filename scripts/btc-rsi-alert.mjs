// Chequea el RSI(14) de BTC en velas de 1h y manda un push por ntfy.sh
// cuando el RSI toca la zona de sobrecompra (>=68) o sobreventa (<=32).
// Mientras el RSI se mantenga fuera de rango, vuelve a avisar en cada
// vela nueva (cada hora) — no solo al momento del cruce.
// También calcula el POC (Point of Control) de volumen sobre las
// últimas 24 velas de 1h y lo incluye en el mensaje.
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PRODUCT = 'BTC-USD';
const GRANULARITY = 3600; // 1h, en segundos
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 68;
const RSI_OVERSOLD = 32;
const POC_LOOKBACK_HOURS = 24;
const POC_BINS = 50;

const STATE_PATH = path.join(process.cwd(), 'data', 'rsi-alert-state.json');

function computeRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) {
    throw new Error(`Se necesitan al menos ${period + 1} velas, llegaron ${closes.length}`);
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

// Perfil de volumen simple: reparte el volumen de cada vela de forma
// pareja entre los bins de precio que cubre su rango [low, high], y
// devuelve el precio del bin con más volumen acumulado.
function computePOC(candles, lookback = POC_LOOKBACK_HOURS, numBins = POC_BINS) {
  const window = candles.slice(-lookback);
  const minLow = Math.min(...window.map((c) => c[1]));
  const maxHigh = Math.max(...window.map((c) => c[2]));
  if (maxHigh === minLow) return minLow;

  const binSize = (maxHigh - minLow) / numBins;
  const volByBin = new Array(numBins).fill(0);

  for (const [, low, high, , , volume] of window) {
    const startBin = Math.max(0, Math.floor((low - minLow) / binSize));
    const endBin = Math.min(numBins - 1, Math.floor((high - minLow) / binSize));
    const binsSpanned = endBin - startBin + 1;
    const volPerBin = volume / binsSpanned;
    for (let b = startBin; b <= endBin; b++) {
      volByBin[b] += volPerBin;
    }
  }

  let maxVol = -1;
  let pocBin = 0;
  for (let b = 0; b < numBins; b++) {
    if (volByBin[b] > maxVol) {
      maxVol = volByBin[b];
      pocBin = b;
    }
  }
  return minLow + (pocBin + 0.5) * binSize;
}

async function fetchHourlyCandles() {
  const url = `https://api.exchange.coinbase.com/products/${PRODUCT}/candles?granularity=${GRANULARITY}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'myportfolio-rsi-alert/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Coinbase respondió ${res.status}: ${await res.text()}`);
  }
  // Cada vela: [time, low, high, open, close, volume] — viene de más nueva a más vieja.
  const raw = await res.json();
  const candles = raw.slice().sort((a, b) => a[0] - b[0]);

  // Descartar la última vela si todavía está en formación (no cerró la hora).
  const last = candles[candles.length - 1];
  const nowSec = Date.now() / 1000;
  if (last && last[0] + GRANULARITY > nowSec) {
    candles.pop();
  }
  return candles;
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { zone: 'neutral', zoneSince: null, lastAlertCandleTime: null, rsi: null, poc: null, updatedAt: null };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function zoneFor(rsi) {
  if (rsi >= RSI_OVERBOUGHT) return 'overbought';
  if (rsi <= RSI_OVERSOLD) return 'oversold';
  return 'neutral';
}

async function sendPush({ title, message, tags, priority }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Falta la env var NTFY_TOPIC');
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const res = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message, tags, priority }),
  });
  if (!res.ok) {
    throw new Error(`ntfy respondió ${res.status}: ${await res.text()}`);
  }
}

async function main() {
  const candles = await fetchHourlyCandles();
  const closes = candles.map((c) => c[4]);
  const lastClose = closes[closes.length - 1];
  const candleTime = candles[candles.length - 1][0];
  const rsi = computeRSI(closes);
  const poc = computePOC(candles);
  const currentZone = zoneFor(rsi);

  const prevState = await loadState();
  const prevZone = prevState.zone || 'neutral';
  const justEntered = currentZone !== prevZone;
  const zoneSince = justEntered ? candleTime : (prevState.zoneSince || candleTime);
  const hoursInZone = Math.max(0, Math.round((candleTime - zoneSince) / GRANULARITY));

  console.log(
    `BTC 1h — precio: $${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · ` +
      `POC(24h): $${poc.toFixed(2)} · zona: ${currentZone} (antes: ${prevZone}, hace ${hoursInZone}h)`
  );

  // Avisa mientras esté fuera de rango, una vez por vela (no repite si se
  // re-ejecuta a mano dentro de la misma hora).
  const shouldAlert = currentZone !== 'neutral' && prevState.lastAlertCandleTime !== candleTime;

  if (shouldAlert) {
    const isOverbought = currentZone === 'overbought';
    const estadoTxt = justEntered
      ? `${isOverbought ? 'subió a' : 'bajó a'} ${rsi.toFixed(1)}`
      : `sigue en ${isOverbought ? 'sobrecompra' : 'sobreventa'} hace ${hoursInZone}h (${rsi.toFixed(1)})`;
    await sendPush({
      title: isOverbought ? '🔴 BTC RSI 1h — Sobrecompra' : '🟢 BTC RSI 1h — Sobreventa',
      message: `RSI(14) en 1h ${estadoTxt} (umbral ${isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD}). ` +
        `Precio BTC: $${lastClose.toFixed(2)} · POC 24h: $${poc.toFixed(2)}`,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
    });
    console.log('Push enviado.');
  }

  await saveState({
    zone: currentZone,
    zoneSince: currentZone === 'neutral' ? null : zoneSince,
    lastAlertCandleTime: shouldAlert ? candleTime : prevState.lastAlertCandleTime,
    rsi,
    poc,
    updatedAt: new Date().toISOString(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
