// Chequea el RSI(14) diario de una lista de acciones/ADRs + cripto y manda
// un push por ntfy.sh (mismo topic que la alerta de BTC 1h) cuando alguno
// entra en sobrecompra (>=70) o sobreventa (<=30).
//
// A diferencia de la alerta de BTC 1h, acá cada ticker avisa UNA vez por
// cruce: se calla mientras sigue fuera de rango y se vuelve a armar recién
// cuando el RSI vuelve a zona neutral.
//
// También detecta divergencias entre el precio y el Momentum Oscillator
// diario (bajista: precio hace un máximo más alto con momentum más débil;
// alcista: precio hace un mínimo más bajo con momentum más fuerte) y
// manda un tipo de notificación aparte (🔀) cuando aparece una nueva.
//
// Un tercer tipo de notificación (🎯 Señal fuerte) dispara cuando una
// divergencia coincide con el RSI en la zona extrema correspondiente:
// la combinación más confiable de reversión.
//
// Todo esto es sobre la temporalidad DIARIA (velas de 1 día). El link a
// TradingView va como texto al final del mensaje (no como acción de
// tocar la notificación), para no navegar por accidente al solo
// querer leerla.
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { computeRSI, computeMomentum, computeSMA, detectDivergence } from './lib/indicators.mjs';

const TIMEFRAME = 'diario';
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const MOMENTUM_PERIOD = 10;
const PIVOT_LOOKBACK = 3;
const SMA_PERIOD = 20;

const STATE_PATH = path.join(process.cwd(), 'data', 'watchlist-rsi-state.json');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

// Acciones/ADRs vía la API de gráficos de Yahoo Finance (gratuita, sin API key).
const STOCKS = ['BMA', 'PAM', 'MELI', 'BIDU', 'MSFT', 'YPF', 'SUPV', 'TGS', 'UBER', 'GGAL', 'TSLA', 'AMD', 'BABA', 'AAPL', 'INTC', 'TS', 'NVDA'];

// Cripto vía Coinbase (BTC ya lo cubre la alerta de 1h, pero lo incluimos
// también en diario para que conviva con el resto del watchlist).
const CRYPTOS = [
  { symbol: 'ETH', product: 'ETH-USD' },
  { symbol: 'BTC', product: 'BTC-USD' },
];

// Símbolo de TradingView para el link "de chart" (la misma URL que genera
// su propio botón de compartir): en el celu, si tenés la app instalada,
// este link la abre directo en vez del navegador.
const TV_SYMBOL_OVERRIDES = { ETH: 'COINBASE:ETHUSD', BTC: 'COINBASE:BTCUSD' };
function chartLinkFor(symbol) {
  const tvSymbol = TV_SYMBOL_OVERRIDES[symbol] || symbol;
  return `🔗 [Ver gráfico en TradingView](https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)})`;
}

async function fetchYahooCloses(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Yahoo respondió ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo: ${data?.chart?.error?.description || 'sin datos'}`);
  }
  const rawCloses = result.indicators?.quote?.[0]?.close || [];
  const rawTimes = result.timestamp || [];
  const closes = [];
  const times = [];
  for (let i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] != null) {
      closes.push(rawCloses[i]);
      times.push(rawTimes[i]);
    }
  }
  if (closes.length < RSI_PERIOD + 1) {
    throw new Error(`Yahoo devolvió muy pocos datos (${closes.length})`);
  }
  return { closes, times };
}

async function fetchCoinbaseDailyCloses(product) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`;
  const res = await fetch(url, { headers: { 'User-Agent': 'myportfolio-rsi-alert/1.0' } });
  if (!res.ok) throw new Error(`Coinbase respondió ${res.status}`);
  const raw = await res.json();
  const candles = raw.slice().sort((a, b) => a[0] - b[0]);

  // Descartar la vela de hoy si todavía no cerró.
  const last = candles[candles.length - 1];
  const nowSec = Date.now() / 1000;
  if (last && last[0] + 86400 > nowSec) candles.pop();

  return { closes: candles.map((c) => c[4]), times: candles.map((c) => c[0]) };
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
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

async function checkTicker(symbol, closes, times, state) {
  const lastClose = closes[closes.length - 1];
  const rsi = computeRSI(closes, RSI_PERIOD);
  const sma20 = computeSMA(closes, SMA_PERIOD);
  const momentum = computeMomentum(closes, MOMENTUM_PERIOD);
  const divergence = detectDivergence(closes, momentum, PIVOT_LOOKBACK);
  const currentZone = zoneFor(rsi);
  const link = chartLinkFor(symbol);
  const smaLine = sma20 != null ? `📏 Media(${SMA_PERIOD}, ${TIMEFRAME}): **${fmt(sma20)}**\n` : '';

  const prev = state[symbol] || {};
  const prevZone = prev.zone || 'neutral';
  const justEntered = currentZone !== 'neutral' && currentZone !== prevZone;

  console.log(
    `${symbol} ${TIMEFRAME} — precio: ${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · ` +
      `Media(${SMA_PERIOD}): ${sma20 != null ? sma20.toFixed(2) : 'N/D'} · zona: ${currentZone} (antes: ${prevZone}) · ` +
      `divergencia: bajista=${divergence.bearish ? 'sí' : 'no'} alcista=${divergence.bullish ? 'sí' : 'no'}`
  );

  // 1) RSI
  if (justEntered) {
    const isOverbought = currentZone === 'overbought';
    const threshold = isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD;
    const comparador = isOverbought ? '≥' : '≤';

    await sendPush({
      title: isOverbought ? `🔴 ${symbol} — Sobrecompra (RSI ${TIMEFRAME})` : `🟢 ${symbol} — Sobreventa (RSI ${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (${comparador} ${threshold})\n` +
        `💰 Precio: **${fmt(lastClose)}**\n` +
        smaLine +
        `\n${link}`,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
    });
    console.log(`  → Push RSI enviado para ${symbol}.`);
  }

  // 2) Divergencia bajista: precio hace un máximo más alto, momentum más débil.
  const bearishDivTime = divergence.bearish ? times[divergence.bearish.i2] : null;
  const shouldAlertBearishDiv = bearishDivTime != null && bearishDivTime !== prev.lastBearishDivTime;
  if (shouldAlertBearishDiv) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      title: `🔀 ${symbol} — Divergencia bajista (Momentum ${TIMEFRAME})`,
      message: `📉 Precio (${TIMEFRAME}): ${fmt(closes[i1])} → **${fmt(closes[i2])}** (nuevo máximo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}): ${momentum[i1].toFixed(2)} → **${momentum[i2].toFixed(2)}** (más débil)\n` +
        smaLine +
        `⚠️ El impulso alcista se está agotando\n\n${link}`,
      tags: ['bar_chart', 'chart_with_downwards_trend'],
      priority: 3,
    });
    console.log(`  → Push divergencia bajista enviado para ${symbol}.`);
  }

  // 3) Divergencia alcista: precio hace un mínimo más bajo, momentum más fuerte.
  const bullishDivTime = divergence.bullish ? times[divergence.bullish.i2] : null;
  const shouldAlertBullishDiv = bullishDivTime != null && bullishDivTime !== prev.lastBullishDivTime;
  if (shouldAlertBullishDiv) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      title: `🔀 ${symbol} — Divergencia alcista (Momentum ${TIMEFRAME})`,
      message: `📈 Precio (${TIMEFRAME}): ${fmt(closes[i1])} → **${fmt(closes[i2])}** (nuevo mínimo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}): ${momentum[i1].toFixed(2)} → **${momentum[i2].toFixed(2)}** (más fuerte)\n` +
        smaLine +
        `⚠️ La presión vendedora se está agotando\n\n${link}`,
      tags: ['bar_chart', 'chart_with_upwards_trend'],
      priority: 3,
    });
    console.log(`  → Push divergencia alcista enviado para ${symbol}.`);
  }

  // 4) Señal combinada: divergencia + RSI en la zona extrema correspondiente.
  const bearishConfluenceTime =
    divergence.bearish && currentZone === 'overbought' ? times[divergence.bearish.i2] : null;
  const shouldAlertBearishConfluence =
    bearishConfluenceTime != null && bearishConfluenceTime !== prev.lastBearishConfluenceTime;
  if (shouldAlertBearishConfluence) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      title: `🎯 ${symbol} — Señal fuerte: Divergencia + Sobrecompra (${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (sobrecompra, ≥ ${RSI_OVERBOUGHT})\n` +
        `📉 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}) más débil en el nuevo máximo: ${momentum[i1].toFixed(2)} → **${momentum[i2].toFixed(2)}**\n` +
        `💰 Precio: **${fmt(lastClose)}**\n` +
        smaLine +
        `⚠️ Divergencia bajista + RSI en zona extrema → señal más confiable de posible reversión a la baja\n\n${link}`,
      tags: ['rotating_light', 'triangular_flag_on_post'],
      priority: 5,
    });
    console.log(`  → Push señal combinada bajista enviado para ${symbol}.`);
  }

  const bullishConfluenceTime =
    divergence.bullish && currentZone === 'oversold' ? times[divergence.bullish.i2] : null;
  const shouldAlertBullishConfluence =
    bullishConfluenceTime != null && bullishConfluenceTime !== prev.lastBullishConfluenceTime;
  if (shouldAlertBullishConfluence) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      title: `🎯 ${symbol} — Señal fuerte: Divergencia + Sobreventa (${TIMEFRAME})`,
      message: `📊 RSI(14, ${TIMEFRAME}): **${rsi.toFixed(1)}** (sobreventa, ≤ ${RSI_OVERSOLD})\n` +
        `📈 Momentum(${MOMENTUM_PERIOD}, ${TIMEFRAME}) más fuerte en el nuevo mínimo: ${momentum[i1].toFixed(2)} → **${momentum[i2].toFixed(2)}**\n` +
        `💰 Precio: **${fmt(lastClose)}**\n` +
        smaLine +
        `⚠️ Divergencia alcista + RSI en zona extrema → señal más confiable de posible reversión al alza\n\n${link}`,
      tags: ['rotating_light', 'triangular_flag_on_post'],
      priority: 5,
    });
    console.log(`  → Push señal combinada alcista enviado para ${symbol}.`);
  }

  state[symbol] = {
    zone: currentZone,
    rsi,
    price: lastClose,
    lastBearishDivTime: shouldAlertBearishDiv ? bearishDivTime : (prev.lastBearishDivTime ?? null),
    lastBullishDivTime: shouldAlertBullishDiv ? bullishDivTime : (prev.lastBullishDivTime ?? null),
    lastBearishConfluenceTime: shouldAlertBearishConfluence
      ? bearishConfluenceTime
      : (prev.lastBearishConfluenceTime ?? null),
    lastBullishConfluenceTime: shouldAlertBullishConfluence
      ? bullishConfluenceTime
      : (prev.lastBullishConfluenceTime ?? null),
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const state = await loadState();

  for (const symbol of STOCKS) {
    try {
      const { closes, times } = await fetchYahooCloses(symbol);
      await checkTicker(symbol, closes, times, state);
    } catch (err) {
      console.error(`Error con ${symbol}: ${err.message}`);
    }
  }

  for (const { symbol, product } of CRYPTOS) {
    try {
      const { closes, times } = await fetchCoinbaseDailyCloses(product);
      await checkTicker(symbol, closes, times, state);
    } catch (err) {
      console.error(`Error con ${symbol} (${product}): ${err.message}`);
    }
  }

  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
