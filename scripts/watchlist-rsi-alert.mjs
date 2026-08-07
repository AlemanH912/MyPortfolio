// Chequea el RSI(14) diario de una lista de acciones/ADRs + cripto y manda
// un push por ntfy.sh (mismo topic que la alerta de BTC 1h) cuando alguno
// entra en sobrecompra (>=70) o sobreventa (<=30).
//
// A diferencia de la alerta de BTC 1h, acá cada ticker avisa UNA vez por
// cruce: se calla mientras sigue fuera de rango y se vuelve a armar recién
// cuando el RSI vuelve a zona neutral.
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { computeRSI } from './lib/indicators.mjs';

const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

const STATE_PATH = path.join(process.cwd(), 'data', 'watchlist-rsi-state.json');

// ADRs/acciones vía Stooq (fuente gratuita, sin API key).
const STOCKS = [
  { symbol: 'BMA', stooq: 'BMA.US' },
  { symbol: 'PAM', stooq: 'PAM.US' },
  { symbol: 'MELI', stooq: 'MELI.US' },
  { symbol: 'BIDU', stooq: 'BIDU.US' },
  { symbol: 'MSFT', stooq: 'MSFT.US' },
  { symbol: 'YPF', stooq: 'YPF.US' },
  { symbol: 'SUPV', stooq: 'SUPV.US' },
  { symbol: 'TGS', stooq: 'TGS.US' },
  { symbol: 'UBER', stooq: 'UBER.US' },
  { symbol: 'GGAL', stooq: 'GGAL.US' },
  { symbol: 'TSLA', stooq: 'TSLA.US' },
  { symbol: 'AMD', stooq: 'AMD.US' },
  { symbol: 'BABA', stooq: 'BABA.US' },
  { symbol: 'AAPL', stooq: 'AAPL.US' },
  { symbol: 'INTC', stooq: 'INTC.US' },
  { symbol: 'TS', stooq: 'TS.US' },
  { symbol: 'NVDA', stooq: 'NVDA.US' },
];

// Cripto vía Coinbase (BTC ya lo cubre la alerta de 1h, pero lo incluimos
// también en diario para que conviva con el resto del watchlist).
const CRYPTOS = [
  { symbol: 'ETH', product: 'ETH-USD' },
  { symbol: 'BTC', product: 'BTC-USD' },
];

async function fetchStooqCloses(stooqSymbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'myportfolio-rsi-alert/1.0' } });
  if (!res.ok) throw new Error(`Stooq respondió ${res.status}`);
  const text = (await res.text()).trim();
  if (!text || /^no data/i.test(text)) throw new Error('Stooq no tiene datos para este símbolo');

  const rows = text
    .split('\n')
    .slice(1) // header: Date,Open,High,Low,Close,Volume
    .map((line) => line.split(','))
    .filter((cols) => cols.length >= 5 && cols[4] !== '');

  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const closes = rows.map((cols) => parseFloat(cols[4]));
  if (closes.some((c) => Number.isNaN(c))) throw new Error('Stooq devolvió datos inválidos');
  return closes;
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

  return candles.map((c) => c[4]);
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
    body: JSON.stringify({ topic, title, message, tags, priority }),
  });
  if (!res.ok) {
    throw new Error(`ntfy respondió ${res.status}: ${await res.text()}`);
  }
}

async function checkTicker(symbol, closes, state) {
  const lastClose = closes[closes.length - 1];
  const rsi = computeRSI(closes, RSI_PERIOD);
  const currentZone = zoneFor(rsi);

  const prevZone = state[symbol]?.zone || 'neutral';
  const justEntered = currentZone !== 'neutral' && currentZone !== prevZone;

  console.log(`${symbol} diario — precio: ${lastClose.toFixed(2)} · RSI(14): ${rsi.toFixed(2)} · zona: ${currentZone} (antes: ${prevZone})`);

  if (justEntered) {
    const isOverbought = currentZone === 'overbought';
    await sendPush({
      title: isOverbought ? `🔴 ${symbol} — Sobrecompra (RSI diario)` : `🟢 ${symbol} — Sobreventa (RSI diario)`,
      message: `${symbol}: RSI(14) diario ${isOverbought ? 'subió a' : 'bajó a'} ${rsi.toFixed(1)} ` +
        `(umbral ${isOverbought ? RSI_OVERBOUGHT : RSI_OVERSOLD}). Precio: ${lastClose.toFixed(2)}`,
      tags: isOverbought ? ['rotating_light', 'chart_with_upwards_trend'] : ['rotating_light', 'chart_with_downwards_trend'],
      priority: 4,
    });
    console.log(`  → Push enviado para ${symbol}.`);
  }

  state[symbol] = { zone: currentZone, rsi, price: lastClose, updatedAt: new Date().toISOString() };
}

async function main() {
  const state = await loadState();

  for (const { symbol, stooq } of STOCKS) {
    try {
      const closes = await fetchStooqCloses(stooq);
      await checkTicker(symbol, closes, state);
    } catch (err) {
      console.error(`Error con ${symbol} (${stooq}): ${err.message}`);
    }
  }

  for (const { symbol, product } of CRYPTOS) {
    try {
      const closes = await fetchCoinbaseDailyCloses(product);
      await checkTicker(symbol, closes, state);
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
