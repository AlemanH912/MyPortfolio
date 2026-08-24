// Wrapper de BTC sobre el bot horario compartido. Ver lib/hourly-signal-bot.mjs.
import path from 'node:path';
import { runHourlyBot } from './lib/hourly-signal-bot.mjs';

await runHourlyBot({
  symbol: 'BTC',
  product: 'BTC-USD',
  statePath: path.join(process.cwd(), 'data', 'rsi-alert-state.json'),
  tvSymbol: 'COINBASE:BTCUSD',
});
