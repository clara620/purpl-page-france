// /api/update-rates.js
// Vercel Cron Job — runs daily at 7:00 UTC (= 9h Paris)
// Strategy:
//   Paysend  → live scrape HTML (rate + fee in SSR HTML)
//   Remitly  → live scrape HTML (rate + fee in SSR HTML)
//   Purpl    → derived from Paysend rate (Purpl uses Paysend corridor)
//   WU / WorldRemit / Sendwave / MoneyGram → mid-market + known markup

import { put } from '@vercel/blob';

const SEND_AMOUNT = 300;

const CALCULATED_PROVIDERS = [
  { id: 'westernunion', name: 'Western Union', fee_eur: 4.90, fx_markup: 0.028, speed: '1–3 heures',       cashout_free: false, note: 'Frais de retrait tiers',       source: 'markup-estimate' },
  { id: 'worldremit',   name: 'WorldRemit',    fee_eur: 2.50, fx_markup: 0.020, speed: '1–3 heures',       cashout_free: false, note: 'Frais de retrait possibles',   source: 'markup-estimate' },
  { id: 'sendwave',     name: 'Sendwave',       fee_eur: 0.00, fx_markup: 0.000, speed: 'Quelques minutes', cashout_free: false, note: 'Frais de retrait ATM au Liban', source: 'calibrated-observed' },
  { id: 'moneygram',    name: 'MoneyGram',      fee_eur: 4.99, fx_markup: 0.032, speed: '2–5 jours',        cashout_free: false, note: 'Frais de retrait tiers',       source: 'markup-estimate' },
];

async function scrapePaysend() {
  const res = await fetch('https://paysend.com/en-fr/send-money/from-france-to-lebanon', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PurplRateBot/1.0)' }
  });
  const html = await res.text();

  const rateMatch = html.match(/1\.00 EUR = ([\d.]+) USD/);
  const feeMatch  = html.match(/Fee:[^0-9]*([\d.]+) USD/);
  if (!rateMatch) throw new Error('Paysend: rate not found in HTML');

  const rate   = parseFloat(rateMatch[1]);
  const feeUsd = feeMatch ? parseFloat(feeMatch[1]) : 1.50;
  const feeEur = feeUsd / rate;
  return {
    id: 'paysend', name: 'Paysend',
    received: parseFloat(((SEND_AMOUNT - feeEur) * rate).toFixed(2)),
    fee: parseFloat(feeEur.toFixed(2)), fee_display: `$${feeUsd.toFixed(2)}`,
    rate, speed: 'Instantané', cashout_free: false,
    note: 'Frais bancaires possibles', source: 'live-scrape'
  };
}

async function scrapeRemitly() {
  const res = await fetch('https://www.remitly.com/fr/en/lebanon/pricing', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PurplRateBot/1.0)' }
  });
  const html = await res.text();

  // Rate is always in SSR HTML: "1 EUR = 1.1628 USD"
  const rateMatch = html.match(/1 EUR = ([\d.]+) USD/);
  if (!rateMatch) throw new Error('Remitly: rate not found in HTML');
  const rate = parseFloat(rateMatch[1]);

  // Remitly prominently shows a "No fees on your first transfer" promo to new visitors.
  // This is the rate displayed on the site — 0 fee, 0 surcharge.
  // Returning customer rate (€1.49 + 2% cash) is listed below but not the headline.
  // We use the promo/new-customer rate to match what visitors actually see.
  const hasPromo = /No fees.*?first transfer/i.test(html);
  const feeEur        = hasPromo ? 0 : 1.49;
  const cashSurcharge = hasPromo ? 0 : 0.02;

  return {
    id: 'remitly', name: 'Remitly',
    received: parseFloat(((SEND_AMOUNT - feeEur) * rate * (1 - cashSurcharge)).toFixed(2)),
    fee: feeEur,
    fee_display: hasPromo ? '0€ (new customer offer)' : `€${feeEur} + ${cashSurcharge * 100}% cash`,
    rate, speed: 'Quelques minutes', cashout_free: false,
    note: hasPromo ? 'Offre nouveau client — 0€ de frais' : 'Frais de retrait tiers',
    source: 'live-scrape'
  };
}

let _midRate = null;
async function getMidRate() {
  if (_midRate) return _midRate;
  try {
    const r = await fetch(`https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE_API_KEY}/pair/EUR/USD`);
    const d = await r.json();
    _midRate = d.conversion_rate;
  } catch { _midRate = 1.143; }
  return _midRate;
}

function calcProvider(p, midRate) {
  const rate    = midRate * (1 - p.fx_markup);
  const netEur  = SEND_AMOUNT - p.fee_eur;
  return {
    id: p.id, name: p.name,
    received: parseFloat((netEur * rate).toFixed(2)),
    fee: p.fee_eur, fee_display: `€${p.fee_eur}`,
    rate: parseFloat(rate.toFixed(4)),
    speed: p.speed, cashout_free: p.cashout_free,
    note: p.note, source: p.source
  };
}

export default async function handler(req, res) {
  const isCron  = !!req.headers['x-vercel-cron'];
  const isAuth  = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron && !isAuth) return res.status(401).json({ error: 'Unauthorized' });

  const errors    = [];
  const providers = [];
  const midRate   = await getMidRate();

  // 1. Paysend — live scrape
  try {
    const p = await scrapePaysend();
    providers.push(p);
    console.log(`[Paysend] ✓ rate=${p.rate} → $${p.received}`);
  } catch (e) {
    errors.push(`Paysend: ${e.message}`);
    console.error('[Paysend] ✗', e.message);
    providers.push(calcProvider({ id:'paysend', name:'Paysend', fee_eur:1.50/midRate, fx_markup:0.010, speed:'Instantané', cashout_free:false, note:'Frais bancaires possibles', source:'fallback' }, midRate));
  }

  // 2. Remitly — live scrape
  try {
    const p = await scrapeRemitly();
    providers.push(p);
    console.log(`[Remitly] ✓ rate=${p.rate} → $${p.received}`);
  } catch (e) {
    errors.push(`Remitly: ${e.message}`);
    console.error('[Remitly] ✗', e.message);
    providers.push(calcProvider({ id:'remitly', name:'Remitly', fee_eur:1.49, fx_markup:0.018, speed:'Quelques minutes', cashout_free:false, note:'Frais de retrait tiers', source:'fallback' }, midRate));
  }

  // 3. Purpl — derived from Paysend live rate
  const ps = providers.find(p => p.id === 'paysend');
  const purplRate = ps ? ps.rate * (1 - 0.005) : midRate * 0.995;
  const purplFeeEur = 1.50 / (ps ? ps.rate : midRate);
  providers.unshift({
    id: 'purpl', name: 'Purpl',
    received: parseFloat(((SEND_AMOUNT - purplFeeEur) * purplRate).toFixed(2)),
    fee: parseFloat(purplFeeEur.toFixed(2)), fee_display: '$1.50',
    rate: parseFloat(purplRate.toFixed(4)),
    speed: 'Instantané', cashout_free: true,
    note: 'Retrait gratuit au Liban',
    source: ps ? 'derived-paysend-live' : 'derived-paysend-fallback'
  });

  // 4. Remaining providers — calculated
  for (const p of CALCULATED_PROVIDERS) {
    providers.push(calcProvider(p, midRate));
  }

  const payload = {
    updated: new Date().toISOString(),
    updated_by: 'cron',
    mid_market_rate: midRate,
    send_amount: SEND_AMOUNT,
    send_currency: 'EUR',
    scrape_errors: errors.length > 0 ? errors : undefined,
    providers
  };

  await put('rates.json', JSON.stringify(payload, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false
  });

  console.log(`[update-rates] ✓ ${providers.length} providers | mid=${midRate} | errors=${errors.length}`);
  return res.status(200).json({ success: true, mid_market_rate: midRate, providers: providers.map(p => ({ id: p.id, received: p.received, source: p.source })), errors });
}
