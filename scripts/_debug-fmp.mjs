// Script de diagnóstico temporal: solo para ver la forma real de la
// respuesta de Financial Modeling Prep antes de integrarla al bot real.
// Se borra apenas confirmamos los nombres de campo correctos.
const KEY = process.env.FMP_API_KEY;
if (!KEY) throw new Error('Falta FMP_API_KEY');

const endpoints = [
  `https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=${KEY}`,
  `https://financialmodelingprep.com/api/v3/ratios-ttm/AAPL?apikey=${KEY}`,
  `https://financialmodelingprep.com/api/v3/price-target-summary/AAPL?apikey=${KEY}`,
  `https://financialmodelingprep.com/api/v3/key-metrics-ttm/AAPL?apikey=${KEY}`,
];

for (const url of endpoints) {
  const safeUrl = url.replace(KEY, 'REDACTED');
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`\n=== ${safeUrl} (status ${res.status}) ===`);
    console.log(text.slice(0, 1500));
  } catch (err) {
    console.log(`\n=== ${safeUrl} ERROR ===`);
    console.log(err.message);
  }
}
