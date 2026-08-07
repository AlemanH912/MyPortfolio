// Chequea el RSI(14) de BTC en velas de 1h y manda un push por ntfy.sh
// cuando el RSI toca la zona de sobrecompra (>=68) o sobreventa (<=32).
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PRODUCT = 'BTC-USD';
const GRANULARITY = 3600; // 1h, en segundos
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 50; // TEMP: umbral bajado para forzar push de prueba, revertir a 68
const RSI_OVERSOLD = 32;

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
    return { zone: 'neutral', rsi: null, updatedAt: null };
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
  const rsi = computeRSI(closes);
  const currentZone = zoneFor(rsi);

  const prevState = await loadState();
  const prevZone = prevState.zone || 'neutral';

  console.log(`BTC 1h — precio: $${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · zona: ${currentZone} (antes: ${prevZone})`);

  const justEntered = currentZone !== 'neutral' && currentZone !== prevZone;

  if (justEntered) {
    const isOverbought = currentZone === 'overbought';
    await sendPush({
      title: isOverbought ? '🔴 BTC RSI 1h — Sobrecompra' : '🟢 BTC RSI 1h — Sobreventa',
      message: `RSI(14) en 1h ${isOverbought ? 'subió a' : 'bajó a'} ${rsi.toFixed(1)} ` +
        `(umbral ${isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD}). Precio BTC: $${lastClose.toFixed(2)}`,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
    });
    console.log('Push enviado.');
  }

  await saveState({ zone: currentZone, rsi, updatedAt: new Date().toISOString() });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
