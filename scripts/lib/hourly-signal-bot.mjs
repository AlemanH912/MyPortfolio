// Bot horario genérico: RSI(14), POC de volumen, media móvil de 20,
// divergencias de Momentum(10) y señal combinada, todo sobre velas de 1h
// (incluyendo la vela en curso, para reaccionar en minutos). Solo la
// señal combinada (🎯, divergencia + RSI en zona extrema) incluye un
// nivel de stop-loss y target — el resto de las notificaciones son
// informativas, sin recomendación de trade.
//
// Se parametriza por símbolo/producto para poder correr el mismo bot en
// distintos activos (BTC, ETH, ...) sin duplicar la lógica.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  computeRSI,
  computeMomentum,
  computeSMA,
  computeATR,
  tradeLevels,
  detectDivergence,
} from './indicators.mjs';

const TIMEFRAME = '1h';
const GRANULARITY = 3600; // 1h, en segundos
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 68;
const RSI_OVERSOLD = 32;
const POC_LOOKBACK_HOURS = 24;
const POC_BINS = 50;
const MOMENTUM_PERIOD = 10;
const PIVOT_LOOKBACK = 3;
const SMA_PERIOD = 20;
const ATR_PERIOD = 14;
const R_MULTIPLE = 2;

const CAVEAT = '_(referencia técnica — no es asesoramiento financiero)_';

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

async function fetchHourlyCandles(product) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${GRANULARITY}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'myportfolio-rsi-alert/1.0' } });
  if (!res.ok) {
    throw new Error(`Coinbase respondió ${res.status}: ${await res.text()}`);
  }
  // Cada vela: [time, low, high, open, close, volume] — viene de más nueva a más vieja.
  // Se incluye la última vela aunque siga en formación: así el RSI
  // refleja el precio en vivo en vez de esperar a que cierre la hora.
  const raw = await res.json();
  return raw.slice().sort((a, b) => a[0] - b[0]);
}

async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
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

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function zoneFor(rsi) {
  if (rsi >= RSI_OVERBOUGHT) return 'overbought';
  if (rsi <= RSI_OVERSOLD) return 'oversold';
  return 'neutral';
}

async function sendPush({ topic, ntfyServer, title, message, tags, priority }) {
  if (!topic) throw new Error('Falta la env var NTFY_TOPIC');
  const server = ntfyServer || 'https://ntfy.sh';
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

function tradeBlock(fmt, price, stop, isBearish) {
  const { target, rMultiple } = tradeLevels(price, stop, isBearish, R_MULTIPLE);
  return `🛑 Stop: **${fmt(stop)}**\n🏁 Target: **${fmt(target)}** (R:R 1:${rMultiple})\n${CAVEAT}`;
}

export async function runHourlyBot({ symbol, product, statePath, tvSymbol }) {
  const fmt = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const chartUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
  const chartLink = () => `🔗 [Ver gráfico en TradingView](${chartUrl})`;
  const topic = process.env.NTFY_TOPIC;
  const ntfyServer = process.env.NTFY_SERVER;

  const candles = await fetchHourlyCandles(product);
  const closes = candles.map((c) => c[4]);
  const lastClose = closes[closes.length - 1];
  const candleTime = candles[candles.length - 1][0];
  const rsi = computeRSI(closes, RSI_PERIOD);
  const poc = computePOC(candles);
  const sma20 = computeSMA(closes, SMA_PERIOD);
  const atr = computeATR(candles, ATR_PERIOD);
  const momentum = computeMomentum(closes, MOMENTUM_PERIOD);
  const divergence = detectDivergence(closes, momentum, PIVOT_LOOKBACK);
  const currentZone = zoneFor(rsi);

  const prevState = await loadState(statePath);
  const prevZone = prevState.zone || 'neutral';
  const justEntered = currentZone !== prevZone;
  const zoneSince = justEntered ? candleTime : (prevState.zoneSince || candleTime);
  const hoursInZone = Math.max(0, Math.round((candleTime - zoneSince) / GRANULARITY));

  console.log(
    `${symbol} ${TIMEFRAME} — precio: $${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · ` +
      `POC(24h): $${poc.toFixed(2)} · Media(${SMA_PERIOD}): ${sma20 != null ? '$' + sma20.toFixed(2) : 'N/D'} · ` +
      `ATR(${ATR_PERIOD}): ${atr != null ? '$' + atr.toFixed(2) : 'N/D'} · ` +
      `zona: ${currentZone} (antes: ${prevZone}, hace ${hoursInZone}h) · ` +
      `divergencia: bajista=${divergence.bearish ? 'sí' : 'no'} alcista=${divergence.bullish ? 'sí' : 'no'}`
  );

  const smaLine = sma20 != null ? `📏 Media(${SMA_PERIOD}, ${TIMEFRAME}): **${fmt(sma20)}**\n` : '';

  // 1) RSI: avisa mientras esté fuera de rango, una vez por vela. Sin
  // recomendación de trade (queda reservada para la señal combinada).
  const shouldAlertRSI = currentZone !== 'neutral' && prevState.lastAlertCandleTime !== candleTime;

  if (shouldAlertRSI) {
    const isOverbought = currentZone === 'overbought';
    const threshold = isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD;
    const comparador = isOverbought ? '≥' : '≤';

    let message = `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (${comparador} ${threshold})\n` +
      `💰 Precio: **${fmt(lastClose)}**\n` +
      smaLine +
      `🎯 POC 24h: ${fmt(poc)}`;
    if (!justEntered) {
      message += `\n⏱ Hace ${hoursInZone}h en esta zona`;
    }
    message += `\n\n${chartLink()}`;

    await sendPush({
      topic,
      ntfyServer,
      title: isOverbought ? `🔴 ${symbol} — Sobrecompra (RSI ${TIMEFRAME})` : `🟢 ${symbol} — Sobreventa (RSI ${TIMEFRAME})`,
      message,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
    });
    console.log('Push RSI enviado.');
  }

  // 2) Divergencia bajista. Sin recomendación de trade.
  const bearishDivTime = divergence.bearish ? candles[divergence.bearish.i2][0] : null;
  const shouldAlertBearishDiv = bearishDivTime !== null && bearishDivTime !== prevState.lastBearishDivTime;
  if (shouldAlertBearishDiv) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      topic,
      ntfyServer,
      title: `🔀 ${symbol} — Divergencia bajista (Momentum ${TIMEFRAME})`,
      message: `📉 Precio (${TIMEFRAME}): ${fmt(closes[i1])} → **${fmt(closes[i2])}** (nuevo máximo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}): ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}** (más débil)\n` +
        smaLine +
        `⚠️ El impulso alcista se está agotando\n\n${chartLink()}`,
      tags: ['bar_chart', 'chart_with_downwards_trend'],
      priority: 3,
    });
    console.log('Push divergencia bajista enviado.');
  }

  // 3) Divergencia alcista. Sin recomendación de trade.
  const bullishDivTime = divergence.bullish ? candles[divergence.bullish.i2][0] : null;
  const shouldAlertBullishDiv = bullishDivTime !== null && bullishDivTime !== prevState.lastBullishDivTime;
  if (shouldAlertBullishDiv) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      topic,
      ntfyServer,
      title: `🔀 ${symbol} — Divergencia alcista (Momentum ${TIMEFRAME})`,
      message: `📈 Precio (${TIMEFRAME}): ${fmt(closes[i1])} → **${fmt(closes[i2])}** (nuevo mínimo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}): ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}** (más fuerte)\n` +
        smaLine +
        `⚠️ La presión vendedora se está agotando\n\n${chartLink()}`,
      tags: ['bar_chart', 'chart_with_upwards_trend'],
      priority: 3,
    });
    console.log('Push divergencia alcista enviado.');
  }

  // 4) Señal combinada: divergencia + RSI en zona extrema al mismo tiempo.
  // Única notificación con recomendación de trade (stop estructural del
  // propio pivote + target a 2R).
  const bearishConfluenceTime =
    divergence.bearish && currentZone === 'overbought' ? candles[divergence.bearish.i2][0] : null;
  const shouldAlertBearishConfluence =
    bearishConfluenceTime !== null && bearishConfluenceTime !== prevState.lastBearishConfluenceTime;
  if (shouldAlertBearishConfluence) {
    const { i1, i2 } = divergence.bearish;
    const stop = closes[i2];
    await sendPush({
      topic,
      ntfyServer,
      title: `🎯 ${symbol} — Señal fuerte: Divergencia + Sobrecompra (${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (sobrecompra, ≥ ${RSI_OVERBOUGHT})\n` +
        `📉 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}) más débil en el nuevo máximo: ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}**\n` +
        `💰 Precio: **${fmt(lastClose)}**\n` +
        smaLine +
        `⚠️ Divergencia bajista + RSI en zona extrema → señal más confiable de posible reversión a la baja\n\n${tradeBlock(fmt, lastClose, stop, true)}\n\n${chartLink()}`,
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
    const stop = closes[i2];
    await sendPush({
      topic,
      ntfyServer,
      title: `🎯 ${symbol} — Señal fuerte: Divergencia + Sobreventa (${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (sobreventa, ≤ ${RSI_OVERSOLD})\n` +
        `📈 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}) más fuerte en el nuevo mínimo: ${momentum[i1].toFixed(1)} → **${momentum[i2].toFixed(1)}**\n` +
        `💰 Precio: **${fmt(lastClose)}**\n` +
        smaLine +
        `⚠️ Divergencia alcista + RSI en zona extrema → señal más confiable de posible reversión al alza\n\n${tradeBlock(fmt, lastClose, stop, false)}\n\n${chartLink()}`,
      tags: ['rotating_light', 'triangular_flag_on_post'],
      priority: 5,
    });
    console.log('Push señal combinada alcista enviado.');
  }

  await saveState(statePath, {
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
