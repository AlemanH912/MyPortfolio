// Chequea el RSI(14) de BTC en velas de 1h (incluyendo la vela en curso,
// para reaccionar en minutos) y manda un push por ntfy.sh cuando toca la
// zona de sobrecompra (>=68) o sobreventa (<=32). Mientras el RSI se
// mantenga fuera de rango, vuelve a avisar en cada vela nueva (cada hora)
// — no solo al momento del cruce. También calcula el POC (Point of
// Control) de volumen sobre las últimas 24 velas de 1h.
//
// Además detecta divergencias entre el precio y el Momentum Oscillator
// (bajista: precio hace un máximo más alto con momentum más débil;
// alcista: precio hace un mínimo más bajo con momentum más fuerte) y
// manda un tipo de notificación aparte (🔀) cuando aparece una nueva.
//
// Nota: como se evalúa la vela en formación, el RSI mostrado es "en vivo"
// y puede variar hasta que cierre la hora (no es repintado histórico,
// es el mismo comportamiento que un RSI intradía en TradingView).
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { computeRSI, computeMomentum, detectDivergence } from './lib/indicators.mjs';

const PRODUCT = 'BTC-USD';
const GRANULARITY = 3600; // 1h, en segundos
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 68;
const RSI_OVERSOLD = 32;
const POC_LOOKBACK_HOURS = 24;
const POC_BINS = 50;
const MOMENTUM_PERIOD = 10;
const PIVOT_LOOKBACK = 3;
const CHART_URL = 'https://www.tradingview.com/symbols/BTCUSD/';

const STATE_PATH = path.join(process.cwd(), 'data', 'rsi-alert-state.json');

const fmtUSD = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

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
  // Se incluye la última vela aunque siga en formación: así el RSI
  // refleja el precio en vivo en vez de esperar a que cierre la hora.
  const raw = await res.json();
  return raw.slice().sort((a, b) => a[0] - b[0]);
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      zone: 'neutral',
      zoneSince: null,
      lastAlertCandleTime: null,
      lastBearishDivTime: null,
      lastBullishDivTime: null,
      rsi: null,
      poc: null,
      updatedAt: null,
    };
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

async function sendPush({ title, message, tags, priority, click }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Falta la env var NTFY_TOPIC');
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const res = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message, tags, priority, click, markdown: true }),
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
  const rsi = computeRSI(closes, RSI_PERIOD);
  const poc = computePOC(candles);
  const momentum = computeMomentum(closes, MOMENTUM_PERIOD);
  const divergence = detectDivergence(closes, momentum, PIVOT_LOOKBACK);
  const currentZone = zoneFor(rsi);

  const prevState = await loadState();
  const prevZone = prevState.zone || 'neutral';
  const justEntered = currentZone !== prevZone;
  const zoneSince = justEntered ? candleTime : (prevState.zoneSince || candleTime);
  const hoursInZone = Math.max(0, Math.round((candleTime - zoneSince) / GRANULARITY));

  console.log(
    `BTC 1h — precio: $${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · ` +
      `POC(24h): $${poc.toFixed(2)} · zona: ${currentZone} (antes: ${prevZone}, hace ${hoursInZone}h) · ` +
      `divergencia: bajista=${divergence.bearish ? 'sí' : 'no'} alcista=${divergence.bullish ? 'sí' : 'no'}`
  );

  // Avisa mientras esté fuera de rango, una vez por vela (no repite si se
  // re-ejecuta dentro de la misma hora ya avisada).
  const shouldAlertRSI = currentZone !== 'neutral' && prevState.lastAlertCandleTime !== candleTime;

  if (shouldAlertRSI) {
    const isOverbought = currentZone === 'overbought';
    const threshold = isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD;
    const comparador = isOverbought ? '≥' : '≤';

    let message = `📊 RSI(14): **${rsi.toFixed(1)}** (${comparador} ${threshold})\n` +
      `💰 Precio: **${fmtUSD(lastClose)}**\n` +
      `🎯 POC 24h: ${fmtUSD(poc)}`;
    if (!justEntered) {
      message += `\n⏱ Hace ${hoursInZone}h en esta zona`;
    }

    await sendPush({
      title: isOverbought ? '🔴 BTC — Sobrecompra (RSI 1h)' : '🟢 BTC — Sobreventa (RSI 1h)',
      message,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
      click: CHART_URL,
    });
    console.log('Push RSI enviado.');
  }

  // Divergencia bajista: precio hace un máximo más alto, momentum más débil.
  const bearishDivTime = divergence.bearish ? candles[divergence.bearish.i2][0] : null;
  const shouldAlertBearishDiv = bearishDivTime !== null && bearishDivTime !== prevState.lastBearishDivTime;
  if (shouldAlertBearishDiv) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      title: '🔀 BTC — Divergencia bajista (Momentum)',
      message: `📉 Precio: ${fmtUSD(closes[i1])} → **${fmtUSD(closes[i2])}** (nuevo máximo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}): ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}** (más débil)\n` +
        `⚠️ El impulso alcista se está agotando`,
      tags: ['bar_chart', 'chart_with_downwards_trend'],
      priority: 3,
      click: CHART_URL,
    });
    console.log('Push divergencia bajista enviado.');
  }

  // Divergencia alcista: precio hace un mínimo más bajo, momentum más fuerte.
  const bullishDivTime = divergence.bullish ? candles[divergence.bullish.i2][0] : null;
  const shouldAlertBullishDiv = bullishDivTime !== null && bullishDivTime !== prevState.lastBullishDivTime;
  if (shouldAlertBullishDiv) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      title: '🔀 BTC — Divergencia alcista (Momentum)',
      message: `📈 Precio: ${fmtUSD(closes[i1])} → **${fmtUSD(closes[i2])}** (nuevo mínimo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}): ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}** (más fuerte)\n` +
        `⚠️ La presión vendedora se está agotando`,
      tags: ['bar_chart', 'chart_with_upwards_trend'],
      priority: 3,
      click: CHART_URL,
    });
    console.log('Push divergencia alcista enviado.');
  }

  await saveState({
    zone: currentZone,
    zoneSince: currentZone === 'neutral' ? null : zoneSince,
    lastAlertCandleTime: shouldAlertRSI ? candleTime : prevState.lastAlertCandleTime,
    lastBearishDivTime: shouldAlertBearishDiv ? bearishDivTime : (prevState.lastBearishDivTime ?? null),
    lastBullishDivTime: shouldAlertBullishDiv ? bullishDivTime : (prevState.lastBullishDivTime ?? null),
    rsi,
    poc,
    updatedAt: new Date().toISOString(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
