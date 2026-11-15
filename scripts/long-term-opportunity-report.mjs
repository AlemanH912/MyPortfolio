// Reporte semanal de oportunidades de largo plazo (horizonte 1-3 años).
//
// A diferencia de los bots viejos de RSI/divergencia (pensados para
// timing de entrada/salida de corto plazo), esto busca señales de
// "empresa valiosa vs. precio actual" usando datos públicos:
//   - Descuento vs. máximo de 52 semanas.
//   - P/E forward más bajo que el P/E actual (se espera que gane más).
//   - Upside implícito del precio objetivo promedio de analistas.
//   - PEG ratio bajo (barata para su crecimiento), cuando está disponible.
// Una acción se marca como "oportunidad destacada" si cumple al menos
// 2 de esas 4 señales. El mensaje semanal SOLO incluye las que destacan
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
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

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
const MIN_SIGNALS_TO_FLAG = 2;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fmtUsd = (n, decimals = 2) =>
  n == null ? 'N/D' : `$${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
const fmtPct = (n, decimals = 0) => (n == null ? 'N/D' : `${(n * 100).toFixed(decimals)}%`);

function chartLink(tvSymbol) {
  return `🔗 [Ver gráfico en TradingView](https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)})`;
}

// Precio actual + máximo de 52 semanas, a partir de velas diarias de Yahoo
// (ya probado y funcionando en el resto de los bots de este repo).
async function fetchYahoo52wHigh(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Yahoo chart respondió ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart: ${data?.chart?.error?.description || 'sin datos'}`);
  const highs = result.indicators?.quote?.[0]?.high || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const high52w = Math.max(...highs.filter((h) => h != null));
  const currentPrice = result.meta?.regularMarketPrice ?? [...closes].reverse().find((c) => c != null);
  if (!Number.isFinite(high52w) || currentPrice == null) throw new Error('Yahoo chart: datos insuficientes');
  return { high52w, currentPrice };
}

// Fundamentals (P/E, PEG, target de analistas). Endpoint más frágil que el
// de velas (Yahoo a veces lo restringe) — si falla, el resto del scoring
// sigue funcionando solo con el descuento vs. máximo de 52 semanas.
async function fetchYahooFundamentals(symbol) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Yahoo quoteSummary respondió ${res.status}`);
  const data = await res.json();
  const result = data?.quoteSummary?.result?.[0];
  if (!result) throw new Error('Yahoo quoteSummary: sin datos');
  return {
    trailingPE: result.summaryDetail?.trailingPE?.raw ?? null,
    forwardPE: result.summaryDetail?.forwardPE?.raw ?? null,
    pegRatio: result.defaultKeyStatistics?.pegRatio?.raw ?? null,
    targetMeanPrice: result.financialData?.targetMeanPrice?.raw ?? null,
  };
}

async function evaluateStock(symbol) {
  const { high52w, currentPrice } = await fetchYahoo52wHigh(symbol);

  let fundamentals = {};
  try {
    fundamentals = await fetchYahooFundamentals(symbol);
  } catch (err) {
    console.log(`  (sin fundamentals para ${symbol}: ${err.message})`);
  }

  const signals = [];
  const discountPct = (high52w - currentPrice) / high52w;
  if (discountPct >= DISCOUNT_52W_THRESHOLD) {
    signals.push(`📉 ${fmtPct(discountPct)} debajo de su máximo de 52 semanas (${fmtUsd(high52w)})`);
  }

  if (fundamentals.forwardPE != null && fundamentals.trailingPE != null && fundamentals.forwardPE < fundamentals.trailingPE) {
    signals.push(`📈 P/E forward ${fundamentals.forwardPE.toFixed(1)} más bajo que el actual ${fundamentals.trailingPE.toFixed(1)} (se espera que gane más)`);
  }

  let upside = null;
  if (fundamentals.targetMeanPrice != null) {
    upside = fundamentals.targetMeanPrice / currentPrice - 1;
    if (upside >= ANALYST_UPSIDE_THRESHOLD) {
      signals.push(`🎯 Analistas ven ${fmtPct(upside)} de upside (precio objetivo prom. ${fmtUsd(fundamentals.targetMeanPrice)})`);
    }
  }

  if (fundamentals.pegRatio != null && fundamentals.pegRatio > 0 && fundamentals.pegRatio < PEG_THRESHOLD) {
    signals.push(`💎 PEG ${fundamentals.pegRatio.toFixed(2)} (barata para su crecimiento esperado)`);
  }

  console.log(
    `${symbol} — precio: ${fmtUsd(currentPrice)} · máx 52w: ${fmtUsd(high52w)} (${fmtPct(discountPct)} debajo) · ` +
      `P/E: ${fundamentals.trailingPE?.toFixed(1) ?? 'N/D'} → fwd ${fundamentals.forwardPE?.toFixed(1) ?? 'N/D'} · ` +
      `PEG: ${fundamentals.pegRatio?.toFixed(2) ?? 'N/D'} · target: ${fundamentals.targetMeanPrice != null ? fmtUsd(fundamentals.targetMeanPrice) : 'N/D'} · ` +
      `señales: ${signals.length}`
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

function evaluateCrypto({ symbol, coingeckoId }, data) {
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

  message += `\n\n_(análisis con datos públicos — no es asesoramiento financiero)_`;
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
