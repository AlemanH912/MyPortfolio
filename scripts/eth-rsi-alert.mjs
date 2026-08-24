// Wrapper de ETH sobre el bot horario compartido. Ver lib/hourly-signal-bot.mjs.
import path from 'node:path';
import { runHourlyBot } from './lib/hourly-signal-bot.mjs';

await runHourlyBot({
  symbol: 'ETH',
  product: 'ETH-USD',
  statePath: path.join(process.cwd(), 'data', 'eth-rsi-alert-state.json'),
  tvSymbol: 'COINBASE:ETHUSD',
});
