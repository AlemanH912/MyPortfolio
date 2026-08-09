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
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { computeRSI, computeMomentum, detectDivergence } from './lib/indicators.mjs';

const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const MOMENTUM_PERIOD = 10;
const PIVOT_LOOKBACK = 3;

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

function chartUrlFor(symbol) {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
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

async function checkTicker(symbol, closes, times, state) {
  const lastClose = closes[closes.length - 1];
  const rsi = computeRSI(closes, RSI_PERIOD);
  const momentum = computeMomentum(closes, MOMENTUM_PERIOD);
  const divergence = detectDivergence(closes, momentum, PIVOT_LOOKBACK);
  const currentZone = zoneFor(rsi);
  const click = chartUrlFor(symbol);

  const prev = state[symbol] || {};
  const prevZone = prev.zone || 'neutral';
  const justEntered = currentZone !== 'neutral' && currentZone !== prevZone;

  console.log(
    `${symbol} diario — precio: ${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · zona: ${currentZone} (antes: ${prevZone}) · ` +
      `divergencia: bajista=${divergence.bearish ? 'sí' : 'no'} alcista=${divergence.bullish ? 'sí' : 'no'}`
  );

  if (justEntered) {
    const isOverbought = currentZone === 'overbought';
    const threshold = isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD;
    const comparador = isOverbought ? '≥' : '≤';

    await sendPush({
      title: isOverbought ? `🔴 ${symbol} — Sobrecompra (RSI diario)` : `🟢 ${symbol} — Sobreventa (RSI diario)`,
      message: `📊 RSI(14): **${rsi.toFixed(1)}** (${comparador} ${threshold})\n💰 Precio: **${fmt(lastClose)}**`,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
      click,
    });
    console.log(`  → Push RSI enviado para ${symbol}.`);
  }

  // Divergencia bajista: precio hace un máximo más alto, momentum más débil.
  const bearishDivTime = divergence.bearish ? times[divergence.bearish.i2] : null;
  const shouldAlertBearishDiv = bearishDivTime != null && bearishDivTime !== prev.lastBearishDivTime;
  if (shouldAlertBearishDiv) {
    const { i1, i2 } = divergence.bearish;
    await sendPush({
      title: `🔀 ${symbol} — Divergencia bajista (Momentum diario)`,
      message: `📉 Precio: ${fmt(closes[i1])} → **${fmt(closes[i2])}** (nuevo máximo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}): ${momentum[i1].toFixed(2)} → **${momentum[i2].toFixed(2)}** (más débil)\n` +
        `⚠️ El impulso alcista se está agotando`,
      tags: ['bar_chart', 'chart_with_downwards_trend'],
      priority: 3,
      click,
    });
    console.log(`  → Push divergencia bajista enviado para ${symbol}.`);
  }

  // Divergencia alcista: precio hace un mínimo más bajo, momentum más fuerte.
  const bullishDivTime = divergence.bullish ? times[divergence.bullish.i2] : null;
  const shouldAlertBullishDiv = bullishDivTime != null && bullishDivTime !== prev.lastBullishDivTime;
  if (shouldAlertBullishDiv) {
    const { i1, i2 } = divergence.bullish;
    await sendPush({
      title: `🔀 ${symbol} — Divergencia alcista (Momentum diario)`,
      message: `📈 Precio: ${fmt(closes[i1])} → **${fmt(closes[i2])}** (nuevo mínimo)\n` +
        `📊 Momentum(${MOMENTUM_PERIOD}): ${momentum[i1].toFixed(2)} → **${momentum[i2].toFixed(2)}** (más fuerte)\n` +
        `⚠️ La presión vendedora se está agotando`,
      tags: ['bar_chart', 'chart_with_upwards_trend'],
      priority: 3,
      click,
    });
    console.log(`  → Push divergencia alcista enviado para ${symbol}.`);
  }

  state[symbol] = {
    zone: currentZone,
    rsi,
    price: lastClose,
    lastBearishDivTime: shouldAlertBearishDiv ? bearishDivTime : (prev.lastBearishDivTime ?? null),
    lastBullishDivTime: shouldAlertBullishDiv ? bullishDivTime : (prev.lastBullishDivTime ?? null),
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
