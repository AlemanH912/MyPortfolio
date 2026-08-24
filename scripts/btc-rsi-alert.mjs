// Chequea el RSI(14) de BTC en velas de 1h (incluyendo la vela en curso,
// para reaccionar en minutos) y manda un push por ntfy.sh cuando toca la
// zona de sobrecompra (>=68) o sobreventa (<=32). Mientras el RSI se
// mantenga fuera de rango, vuelve a avisar en cada vela nueva (cada hora)
// — no solo al momento del cruce. También calcula el POC (Point of
// Control) de volumen sobre las últimas 24 velas de 1h y la media móvil
// simple de 20 velas.
//
// Además detecta divergencias entre el precio y el Momentum Oscillator
// (bajista: precio hace un máximo más alto con momentum más débil;
// alcista: precio hace un mínimo más bajo con momentum más fuerte) y
// manda un tipo de notificación aparte (🔀) cuando aparece una nueva.
//
// Un tercer tipo de notificación (🎯 Señal fuerte) dispara cuando una
// divergencia coincide con el RSI en la zona extrema correspondiente:
// eso es la combinación más confiable de reversión (bajista+sobrecompra
// o alcista+sobreventa).
//
// Todo esto es sobre la temporalidad de 1h (velas horarias de BTC-USD).
// El link a TradingView va como texto al final del mensaje (no como
// acción de tocar la notificación), para no navegar por accidente al
// solo querer leerla.
//
// Nota: como se evalúa la vela en formación, el RSI mostrado es "en vivo"
// y puede variar hasta que cierre la hora (no es repintado histórico,
// es el mismo comportamiento que un RSI intradía en TradingView).
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { computeRSI, computeMomentum, computeSMA, detectDivergence } from './lib/indicators.mjs';

const PRODUCT = 'BTC-USD';
const GRANULARITY = 3600; // 1h, en segundos
const TIMEFRAME = '1h';
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 68;
const RSI_OVERSOLD = 32;
const POC_LOOKBACK_HOURS = 24;
const POC_BINS = 50;
const MOMENTUM_PERIOD = 10;
const PIVOT_LOOKBACK = 3;
const SMA_PERIOD = 20;
// URL "de chart" de TradingView (la misma que genera su propio botón de
// compartir): en el celu, si tenés la app instalada, este link la abre
// directo en vez del navegador.
const CHART_URL = 'https://www.tradingview.com/chart/?symbol=COINBASE:BTCUSD';
const chartLink = () => `🔗 [Ver gráfico en TradingView](${CHART_URL})`;

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
      lastBearishConfluenceTime: null,
      lastBullishConfluenceTime: null,
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

async function sendPush({ title, message, tags, priority }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Falta la env var NTFY_TOPIC');
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const res = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Sin "click": tocar la notificación solo la abre/expande, no navega.
    body: JSON.stringify({ topic, title, message, tags, priority, markdown: true }),
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
  const sma20 = computeSMA(closes, SMA_PERIOD);
  const momentum = computeMomentum(closes, MOMENTUM_PERIOD);
  const divergence = detectDivergence(closes, momentum, PIVOT_LOOKBACK);
  const currentZone = zoneFor(rsi);

  const prevState = await loadState();
  const prevZone = prevState.zone || 'neutral';
  const justEntered = currentZone !== prevZone;
  const zoneSince = justEntered ? candleTime : (prevState.zoneSince || candleTime);
  const hoursInZone = Math.max(0, Math.round((candleTime - zoneSince) / GRANULARITY));

  console.log(
    `BTC ${TIMEFRAME} — precio: $${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · ` +
      `POC(24h): $${poc.toFixed(2)} · Media(${SMA_PERIOD}): ${sma20 != null ? '$' + sma20.toFixed(2) : 'N/D'} · ` +
      `zona: ${currentZone} (antes: ${prevZone}, hace ${hoursInZone}h) · ` +
      `divergencia: bajista=${divergence.bearish ? 'sí' : 'no'} alcista=${divergence.bullish ? 'sí' : 'no'}`
  );

  const smaLine = sma20 != null ? `📏 Media(${SMA_PERIOD}, ${TIMEFRAME}): **${fmtUSD(sma20)}**\n` : '';

  // 1) RSI: avisa mientras esté fuera de rango, una vez por vela (no
  // repite si se re-ejecuta dentro de la misma hora ya avisada).
  const shouldAlertRSI = currentZone !== 'neutral' && prevState.lastAlertCandleTime !== candleTime;

  if (shouldAlertRSI) {
    const isOverbought = currentZone === 'overbought';
    const threshold = isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD;
    const comparador = isOverbought ? '≥' : '≤';

    let message = `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (${comparador} ${threshold})\n` +
      `💰 Precio: **${fmtUSD(lastClose)}**\n` +
      smaLine +
      `🎯 POC 24h: ${fmtUSD(poc)}`;
    if (!justEntered) {
      message += `\n⏱ Hace ${hoursInZone}h en esta zona`;
    }
    message += `\n\n${chartLink()}`;

    await sendPush({
      title: isOverbought ? `🔴 BTC — Sobrecompra (RSI ${TIMEFRAME})` : `🟢 BTC — Sobreventa (RSI ${TIMEFRAME})`,
      message,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
    });
    console.log('Push RSI enviado.');
  }

  // 2) Divergencia bajista: precio hace un máximo más alto, momentum más débil.
  const bearishDivTime = divergence.bearish ? candles[divergence.bearish.i2][0] : null;
  const shouldAlertBearishDiv = bearishDivTime !== null && bearishDivTime !== prevState.lastBearishDivTime;
  if (shouldAlertBearishDiv) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      title: `🔀 BTC — Divergencia bajista (Momentum ${TIMEFRAME})`,
      message: `📉 Precio (${TIMEFRAME}): ${fmtUSD(closes[i1])} → **${fmtUSD(closes[i2])}** (nuevo máximo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}): ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}** (más débil)\n` +
        smaLine +
        `⚠️ El impulso alcista se está agotando\n\n${chartLink()}`,
      tags: ['bar_chart', 'chart_with_downwards_trend'],
      priority: 3,
    });
    console.log('Push divergencia bajista enviado.');
  }

  // 3) Divergencia alcista: precio hace un mínimo más bajo, momentum más fuerte.
  const bullishDivTime = divergence.bullish ? candles[divergence.bullish.i2][0] : null;
  const shouldAlertBullishDiv = bullishDivTime !== null && bullishDivTime !== prevState.lastBullishDivTime;
  if (shouldAlertBullishDiv) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      title: `🔀 BTC — Divergencia alcista (Momentum ${TIMEFRAME})`,
      message: `📈 Precio (${TIMEFRAME}): ${fmtUSD(closes[i1])} → **${fmtUSD(closes[i2])}** (nuevo mínimo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}): ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}** (más fuerte)\n` +
        smaLine +
        `⚠️ La presión vendedora se está agotando\n\n${chartLink()}`,
      tags: ['bar_chart', 'chart_with_upwards_trend'],
      priority: 3,
    });
    console.log('Push divergencia alcista enviado.');
  }

  // 4) Señal combinada: divergencia + RSI en la zona extrema correspondiente
  // al mismo tiempo. Es la lectura clásica de mayor confiabilidad.
  // Se deduplica por separado (por pivote), independiente de si la
  // divergencia "simple" ya avisó en un run anterior.
  const bearishConfluenceTime =
    divergence.bearish && currentZone === 'overbought' ? candles[divergence.bearish.i2][0] : null;
  const shouldAlertBearishConfluence =
    bearishConfluenceTime !== null && bearishConfluenceTime !== prevState.lastBearishConfluenceTime;
  if (shouldAlertBearishConfluence) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      title: `🎯 BTC — Señal fuerte: Divergencia + Sobrecompra (${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (sobrecompra, ≥ ${RSI_OVERBOUGHT})\n` +
        `📉 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}) más débil en el nuevo máximo: ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}**\n` +
        `💰 Precio: **${fmtUSD(lastClose)}**\n` +
        smaLine +
        `⚠️ Divergencia bajista + RSI en zona extrema → señal más confiable de posible reversión a la baja\n\n${chartLink()}`,
      tags: ['rotating_light', 'triangular_flag_on_post'],
      priority: 5,
    });
    console.log('Push señal combinada bajista enviado.');
  }

  const bullishConfluenceTime =
    divergence.bullish && currentZone === 'oversold' ? candles[divergence.bullish.i2][0] : null;
  const shouldAlertBullishConfluence =
    bullishConfluenceTime !== null && bullishConfluenceTime !== prevState.lastBullishConfluenceTime;
  if (shouldAlertBullishConfluence) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      title: `🎯 BTC — Señal fuerte: Divergencia + Sobreventa (${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (sobreventa, ≤ ${RSI_OVERSOLD})\n` +
        `📈 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}) más fuerte en el nuevo mínimo: ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}**\n` +
        `💰 Precio: **${fmtUSD(lastClose)}**\n` +
        smaLine +
        `⚠️ Divergencia alcista + RSI en zona extrema → señal más confiable de posible reversión al alza\n\n${chartLink()}`,
      tags: ['rotating_light', 'triangular_flag_on_post'],
      priority: 5,
    });
    console.log('Push señal combinada alcista enviado.');
  }

  await saveState({
    zone: currentZone,
    zoneSince: currentZone === 'neutral' ? null : zoneSince,
    lastAlertCandleTime: shouldAlertRSI ? candleTime : prevState.lastAlertCandleTime,
    lastBearishDivTime: shouldAlertBearishDiv ? bearishDivTime : (prevState.lastBearishDivTime ?? null),
    lastBullishDivTime: shouldAlertBullishDiv ? bullishDivTime : (prevState.lastBullishDivTime ?? null),
    lastBearishConfluenceTime: shouldAlertBearishConfluence
      ? bearishConfluenceTime
      : (prevState.lastBearishConfluenceTime ?? null),
    lastBullishConfluenceTime: shouldAlertBullishConfluence
      ? bullishConfluenceTime
      : (prevState.lastBullishConfluenceTime ?? null),
    rsi,
    poc,
    updatedAt: new Date().toISOString(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
