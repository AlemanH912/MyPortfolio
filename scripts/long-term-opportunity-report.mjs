// Reporte semanal de oportunidades de largo plazo (horizonte 1-3 años).
//
// A diferencia de los bots viejos de RSI/divergencia (pensados para
// timing de entrada/salida de corto plazo), esto busca señales de
// "empresa valiosa vs. precio actual" usando datos de Financial
// Modeling Prep (financialmodelingprep.com, requiere FMP_API_KEY):
//   - Descuento vs. máximo de 52 semanas.
//   - PEG ratio bajo (barata para su crecimiento).
//   - Upside implícito del precio objetivo (consenso de analistas).
//   - Precio por debajo de su "número de Graham" (valor razonable
//     clásico de Benjamin Graham: sqrt(22.5 × EPS × valor libro)).
// Una acción se marca como "oportunidad destacada" si cumple al menos
// 3 de esas 4 señales (exigente a propósito, para que la lista sea
// realmente corta incluso en semanas de caída generalizada del
// mercado, donde muchas acciones cumplirían 2 señales a la vez sin
// decir demasiado). El mensaje semanal SOLO incluye las que destacan
// esa semana (puede no llegar nada si ninguna se gana el lugar).
//
// Para cripto (BTC/ETH) no hay "oportunidad destacada" filtrada: se
// manda siempre un pulso corto de contexto macro (distancia al máximo
// histórico, y para BTC los meses desde el último halving), porque son
// solo 2 activos y el objetivo es tener noción del ciclo, no timing.
//
// Sin estado persistente: es un reporte periódico, no una alerta de
// cruce, así que no hace falta recordar nada entre corridas.
//
// Requiere Node 20+ (fetch global) y las env vars NTFY_TOPIC y FMP_API_KEY.

const STOCKS = [
  'AAPL', 'NVDA', 'INTC', 'GOOGL', 'TSLA',
  'MSFT', 'AMZN', 'META', 'AMD', 'AVGO', 'TSM',
  'BABA', 'NFLX', 'V', 'MA', 'JPM', 'KO', 'BRK-B',
];

const CRYPTOS = [
  { symbol: 'BTC', coingeckoId: 'bitcoin', tvSymbol: 'COINBASE:BTCUSD' },
  { symbol: 'ETH', coingeckoId: 'ethereum', tvSymbol: 'COINBASE:ETHUSD' },
];

const BTC_HALVING_DATE = new Date('2024-04-20T00:00:00Z');

const DISCOUNT_52W_THRESHOLD = 0.15; // 15% debajo del máximo de 52 semanas
const ANALYST_UPSIDE_THRESHOLD = 0.15; // 15% de upside implícito
const PEG_THRESHOLD = 1.5;
const MIN_SIGNALS_TO_FLAG = 3;

const FMP_KEY = process.env.FMP_API_KEY;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fmtUsd = (n, decimals = 2) =>
  n == null ? 'N/D' : `$${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
const fmtPct = (n, decimals = 0) => (n == null ? 'N/D' : `${(n * 100).toFixed(decimals)}%`);

function chartLink(tvSymbol) {
  return `🔗 [Ver gráfico en TradingView](https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)})`;
}

async function fmpGet(path, symbol) {
  if (!FMP_KEY) throw new Error('Falta la env var FMP_API_KEY');
  const url = `https://financialmodelingprep.com/stable/${path}?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${path} respondió ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`FMP ${path}: sin datos`);
  return data[0];
}

async function evaluateStock(symbol) {
  const quote = await fmpGet('quote', symbol);
  const currentPrice = quote.price;
  const yearHigh = quote.yearHigh;
  if (currentPrice == null || yearHigh == null) throw new Error('quote sin price/yearHigh');

  const signals = [];

  const discountPct = (yearHigh - currentPrice) / yearHigh;
  if (discountPct >= DISCOUNT_52W_THRESHOLD) {
    signals.push(`📉 ${fmtPct(discountPct)} debajo de su máximo de 52 semanas (${fmtUsd(yearHigh)})`);
  }

  let peg = null;
  try {
    const ratios = await fmpGet('ratios-ttm', symbol);
    peg = ratios.priceToEarningsGrowthRatioTTM ?? null;
    if (peg != null && peg > 0 && peg < PEG_THRESHOLD) {
      signals.push(`💎 PEG ${peg.toFixed(2)} (barata para su crecimiento esperado)`);
    }
  } catch (err) {
    console.log(`  (sin ratios para ${symbol}: ${err.message})`);
  }

  let upside = null;
  try {
    const target = await fmpGet('price-target-consensus', symbol);
    const consensus = target.targetConsensus ?? target.targetMedian ?? null;
    if (consensus != null) {
      upside = consensus / currentPrice - 1;
      if (upside >= ANALYST_UPSIDE_THRESHOLD) {
        signals.push(`🎯 Analistas ven ${fmtPct(upside)} de upside (precio objetivo consenso ${fmtUsd(consensus)})`);
      }
    }
  } catch (err) {
    console.log(`  (sin price target para ${symbol}: ${err.message})`);
  }

  let graham = null;
  try {
    const metrics = await fmpGet('key-metrics-ttm', symbol);
    graham = metrics.grahamNumberTTM ?? null;
    if (graham != null && graham > 0 && currentPrice < graham) {
      signals.push(`📐 ${fmtPct(graham / currentPrice - 1)} debajo de su "número de Graham" (${fmtUsd(graham)}, valor razonable clásico)`);
    }
  } catch (err) {
    console.log(`  (sin key-metrics para ${symbol}: ${err.message})`);
  }

  console.log(
    `${symbol} — precio: ${fmtUsd(currentPrice)} · máx 52w: ${fmtUsd(yearHigh)} (${fmtPct(discountPct)} debajo) · ` +
      `PEG: ${peg?.toFixed(2) ?? 'N/D'} · upside analistas: ${upside != null ? fmtPct(upside) : 'N/D'} · ` +
      `Graham: ${graham != null ? fmtUsd(graham) : 'N/D'} · señales: ${signals.length}`
  );

  return { symbol, currentPrice, signals, flagged: signals.length >= MIN_SIGNALS_TO_FLAG };
}

async function fetchCoinGeckoData(coingeckoId) {
  const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`CoinGecko respondió ${res.status}`);
  const data = await res.json();
  const md = data?.market_data;
  if (!md) throw new Error('CoinGecko: sin market_data');
  return {
    currentPrice: md.current_price?.usd ?? null,
    athPrice: md.ath?.usd ?? null,
    athChangePct: md.ath_change_percentage?.usd ?? null, // ya viene negativo
  };
}

function evaluateCrypto({ symbol }, data) {
  const belowAth = Math.abs(data.athChangePct) / 100;
  let line = `${symbol}: ${fmtUsd(data.currentPrice, 0)} · ${fmtPct(belowAth)} debajo de su máximo histórico (${fmtUsd(data.athPrice, 0)})`;

  if (symbol === 'BTC') {
    const daysSinceHalving = Math.floor((Date.now() - BTC_HALVING_DATE.getTime()) / 86400000);
    const monthsSinceHalving = Math.round(daysSinceHalving / 30.44);
    line += `\n⏳ ${monthsSinceHalving} meses desde el último halving (hist. los rallies fuertes llegaron entre 12 y 18 meses después)`;
  }

  console.log(`${symbol} — precio: ${fmtUsd(data.currentPrice, 0)} · ${fmtPct(belowAth)} debajo del ATH (${fmtUsd(data.athPrice, 0)})`);

  return line;
}

async function sendPush({ title, message, tags, priority }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Falta la env var NTFY_TOPIC');
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const res = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message, tags, priority, markdown: true }),
  });
  if (!res.ok) throw new Error(`ntfy respondió ${res.status}: ${await res.text()}`);
}

async function main() {
  const cryptoLines = [];
  for (const crypto of CRYPTOS) {
    try {
      const data = await fetchCoinGeckoData(crypto.coingeckoId);
      cryptoLines.push(evaluateCrypto(crypto, data));
    } catch (err) {
      console.error(`Error con ${crypto.symbol}: ${err.message}`);
    }
  }

  const flagged = [];
  for (const symbol of STOCKS) {
    try {
      const result = await evaluateStock(symbol);
      if (result.flagged) flagged.push(result);
    } catch (err) {
      console.error(`Error con ${symbol}: ${err.message}`);
    }
  }

  let message = `🌍 *Panorama cripto*\n${cryptoLines.join('\n\n')}\n\n`;

  if (flagged.length > 0) {
    message += `💼 *Oportunidades destacadas esta semana* (${flagged.length})\n\n`;
    message += flagged
      .map((f) => `**${f.symbol}** — ${fmtUsd(f.currentPrice)}\n${f.signals.join('\n')}`)
      .join('\n\n');
  } else {
    message += `💼 *Acciones*: ninguna de las ${STOCKS.length} que sigo destaca especialmente esta semana (necesitan al menos ${MIN_SIGNALS_TO_FLAG} señales de valor para aparecer acá).`;
  }

  message += `\n\n_(análisis con datos públicos de Financial Modeling Prep — no es asesoramiento financiero)_`;
  message += `\n\n${chartLink('COINBASE:BTCUSD')}`;

  await sendPush({
    title: `Reporte semanal — oportunidades de largo plazo`,
    message,
    tags: ['bar_chart', 'moneybag'],
    priority: 3,
  });
  console.log('Push semanal enviado.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
