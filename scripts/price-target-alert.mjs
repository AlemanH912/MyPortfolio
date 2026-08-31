// Alertas de precio "una vez y listo": avisa cuando un activo toca el
// target definido y no vuelve a avisar nunca más para ese target (a
// diferencia de los bots de RSI, que rearman la alerta).
//
// Para agregar/sacar targets, editar el array TARGETS de abajo.
//
// Requiere Node 20+ (fetch global) y la env var NTFY_TOPIC.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const STATE_PATH = path.join(process.cwd(), 'data', 'price-target-state.json');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// direction: 'sell' -> avisa cuando precio >= target. 'buy' -> precio <= target.
const TARGETS = [
  { id: 'MELI', kind: 'usd-stock', yahooSymbol: 'MELI', target: 2498, direction: 'sell' },
  { id: 'ALUA', kind: 'ars-usd-ccl', araSymbol: 'ALUA.BA', target: 0.594, direction: 'sell' },
];

const fmt = (n, decimals = 2) => n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

async function fetchYahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Yahoo respondió ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: ${data?.chart?.error?.description || 'sin datos'}`);
  const price = result.meta?.regularMarketPrice;
  if (price == null) throw new Error('Yahoo no devolvió regularMarketPrice');
  return price;
}

// CCL implícito vía GGAL: 1 ADR GGAL = 10 acciones locales GGAL.BA.
async function fetchImpliedCCL() {
  const [ggalBA, ggalADR] = await Promise.all([fetchYahooPrice('GGAL.BA'), fetchYahooPrice('GGAL')]);
  return (ggalBA * 10) / ggalADR;
}

async function getPriceUSD(cfg) {
  if (cfg.kind === 'usd-stock') {
    return fetchYahooPrice(cfg.yahooSymbol);
  }
  if (cfg.kind === 'ars-usd-ccl') {
    const [priceARS, ccl] = await Promise.all([fetchYahooPrice(cfg.araSymbol), fetchImpliedCCL()]);
    return priceARS / ccl;
  }
  throw new Error(`kind desconocido: ${cfg.kind}`);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
  const state = await loadState();

  for (const cfg of TARGETS) {
    if (state[cfg.id]?.triggered) {
      console.log(`${cfg.id}: ya disparó el ${state[cfg.id].triggeredAt}, se omite.`);
      continue;
    }

    try {
      const price = await getPriceUSD(cfg);
      const reached = cfg.direction === 'sell' ? price >= cfg.target : price <= cfg.target;
      console.log(
        `${cfg.id}: precio ${fmt(price, cfg.kind === 'ars-usd-ccl' ? 3 : 2)} · target ${cfg.direction} ${fmt(cfg.target, cfg.kind === 'ars-usd-ccl' ? 3 : 2)} · ${reached ? 'ALCANZADO' : 'todavía no'}`
      );

      if (reached) {
        const decimals = cfg.kind === 'ars-usd-ccl' ? 3 : 2;
        await sendPush({
          title: `🔔 ${cfg.id} — Target de ${cfg.direction === 'sell' ? 'venta' : 'compra'} alcanzado`,
          message: `💰 Precio actual: **$${fmt(price, decimals)}**\n` +
            `🎯 Target: **$${fmt(cfg.target, decimals)}**\n` +
            (cfg.kind === 'ars-usd-ccl' ? `_(precio en USD, convertido vía CCL implícito de GGAL)_\n` : '') +
            `\n✅ Esta alerta no se repite.`,
          tags: ['bell', cfg.direction === 'sell' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
          priority: 5,
        });
        state[cfg.id] = { triggered: true, triggeredAt: new Date().toISOString(), price, target: cfg.target };
        console.log(`  → Push enviado para ${cfg.id}. No se volverá a chequear.`);
      }
    } catch (err) {
      console.error(`Error con ${cfg.id}: ${err.message}`);
    }
  }

  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
