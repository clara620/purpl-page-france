// /api/rates.js
// Scrapes live rates from Paysend and Remitly on each request
// Falls back to calculated values using exchangerate-api for others
// No storage needed — computed fresh on each call (cached by Vercel CDN for 1 hour)

const SEND = 300;

const CALCULATED = [
  { id: 'westernunion', name: 'Western Union', fee: 4.90, markup: 0.028, speed: '1–3 heures',       cashout_free: false, note: 'Frais de retrait tiers'        },
  { id: 'worldremit',   name: 'WorldRemit',    fee: 2.50, markup: 0.020, speed: '1–3 heures',       cashout_free: false, note: 'Frais de retrait possibles'    },
  { id: 'sendwave',     name: 'Sendwave',       fee: 0.00, markup: 0.000, speed: 'Quelques minutes', cashout_free: false, note: 'Frais de retrait ATM au Liban' },
  { id: 'moneygram',    name: 'MoneyGram',      fee: 4.99, markup: 0.032, speed: '2–5 jours',        cashout_free: false, note: 'Frais de retrait tiers'        },
];

async function scrapePaysend() {
  const res = await fetch('https://paysend.com/en-fr/send-money/from-france-to-lebanon', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PurplBot/1.0)' }
  });
  const html = await res.text();
  const rateMatch = html.match(/1\.00 EUR = ([\d.]+) USD/);
  const feeMatch  = html.match(/Fee:[^0-9]*([\d.]+) USD/);
  if (!rateMatch) throw new Error('Paysend rate not found');
  const rate   = parseFloat(rateMatch[1]);
  const feeUsd = feeMatch ? parseFloat(feeMatch[1]) : 1.50;
  const feeEur = feeUsd / rate;
  return { rate, feeEur, feeUsd };
}

async function scrapeRemitly() {
  const res = await fetch('https://www.remitly.com/fr/en/lebanon/pricing', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PurplBot/1.0)' }
  });
  const html = await res.text();
  const rateMatch = html.match(/1 EUR = ([\d.]+) USD/);
  if (!rateMatch) throw new Error('Remitly rate not found');
  const rate     = parseFloat(rateMatch[1]);
  const hasPromo = /No fees.*?first transfer/i.test(html);
  return { rate, hasPromo };
}

async function getMidRate() {
  try {
    const key = process.env.EXCHANGE_RATE_API_KEY;
    if (!key) return 1.143;
    const r = await fetch(`https://v6.exchangerate-api.com/v6/${key}/pair/EUR/USD`);
    const d = await r.json();
    return d.conversion_rate || 1.143;
  } catch { return 1.143; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  const [paysendData, remitlyData, midRate] = await Promise.allSettled([
    scrapePaysend(), scrapeRemitly(), getMidRate()
  ]);

  const mid = midRate.status === 'fulfilled' ? midRate.value : 1.143;
  const providers = [];

  // Paysend
  let paysendRate = mid * 0.990;
  if (paysendData.status === 'fulfilled') {
    const { rate, feeEur } = paysendData.value;
    paysendRate = rate;
    providers.push({
      id: 'paysend', name: 'Paysend',
      received: parseFloat(((SEND - feeEur) * rate).toFixed(2)),
      fee: parseFloat(feeEur.toFixed(2)), speed: 'Instantané',
      cashout_free: false, note: 'Frais bancaires possibles', source: 'live'
    });
  } else {
    providers.push({
      id: 'paysend', name: 'Paysend',
      received: parseFloat(((SEND - 1.50 / mid) * mid * 0.990).toFixed(2)),
      fee: parseFloat((1.50 / mid).toFixed(2)), speed: 'Instantané',
      cashout_free: false, note: 'Frais bancaires possibles', source: 'fallback'
    });
  }

  // Purpl (derived from Paysend)
  const purplRate = paysendRate * 0.995;
  const purplFee  = 1.50 / paysendRate;
  providers.unshift({
    id: 'purpl', name: 'Purpl',
    received: parseFloat(((SEND - purplFee) * purplRate).toFixed(2)),
    fee: parseFloat(purplFee.toFixed(2)), speed: 'Instantané',
    cashout_free: true, note: 'Retrait gratuit au Liban',
    source: paysendData.status === 'fulfilled' ? 'derived-live' : 'derived-fallback'
  });

  // Remitly
  if (remitlyData.status === 'fulfilled') {
    const { rate, hasPromo } = remitlyData.value;
    const fee = hasPromo ? 0 : 1.49;
    const surcharge = hasPromo ? 0 : 0.02;
    providers.push({
      id: 'remitly', name: 'Remitly',
      received: parseFloat(((SEND - fee) * rate * (1 - surcharge)).toFixed(2)),
      fee, speed: 'Quelques minutes', cashout_free: false,
      note: hasPromo ? 'Offre nouveau client — 0€ de frais' : 'Frais de retrait tiers',
      source: 'live'
    });
  } else {
    providers.push({
      id: 'remitly', name: 'Remitly',
      received: parseFloat((SEND * mid * 1.0).toFixed(2)),
      fee: 0, speed: 'Quelques minutes', cashout_free: false,
      note: 'Offre nouveau client — 0€ de frais', source: 'fallback'
    });
  }

  // Calculated providers
  for (const p of CALCULATED) {
    const rate = mid * (1 - p.markup);
    providers.push({
      id: p.id, name: p.name,
      received: parseFloat(((SEND - p.fee) * rate).toFixed(2)),
      fee: p.fee, speed: p.speed,
      cashout_free: p.cashout_free, note: p.note, source: 'calculated'
    });
  }

  return res.status(200).json({
    updated: new Date().toISOString(),
    updated_by: 'live',
    mid_market_rate: mid,
    send_amount: SEND,
    send_currency: 'EUR',
    providers
  });
}
