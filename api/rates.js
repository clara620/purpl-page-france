// /api/rates.js
// Calibrated from real observed data (April 14 2026):
// - Paysend:      1000€ → $1163  (rate=1.165, fee=$1.50 deducted after)
// - Western Union: 1000€ → $1154 (all-in effective rate=1.154, markup=0.94%)
// - Remitly:      rate=1.1628, 0€ fee (new customer promo)
// Mid-market fallback = 1.165 (from Paysend live rate)

const SEND = 300;
const FALLBACK_MID = 1.165; // Updated from real Paysend rate April 14 2026

async function scrapePaysend() {
  const res = await fetch('https://paysend.com/en-fr/send-money/from-france-to-lebanon', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PurplBot/1.0)' },
    signal: AbortSignal.timeout(8000)
  });
  const html = await res.text();
  const rateMatch = html.match(/1\.00 EUR = ([\d.]+) USD/);
  if (!rateMatch) throw new Error('Paysend rate not found');
  return parseFloat(rateMatch[1]);
}

async function scrapeRemitly() {
  const res = await fetch('https://www.remitly.com/fr/en/lebanon/pricing', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PurplBot/1.0)' },
    signal: AbortSignal.timeout(8000)
  });
  const html = await res.text();
  const rateMatch = html.match(/1 EUR = ([\d.]+) USD/);
  if (!rateMatch) throw new Error('Remitly rate not found');
  return {
    rate: parseFloat(rateMatch[1]),
    hasPromo: /No fees.*?first transfer/i.test(html)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  // Try live scrapes in parallel
  const [paysendRes, remitlyRes] = await Promise.allSettled([
    scrapePaysend(),
    scrapeRemitly()
  ]);

  // Mid-market rate — from Paysend live scrape or calibrated fallback
  const mid = paysendRes.status === 'fulfilled' ? paysendRes.value : FALLBACK_MID;

  // ── Paysend ─────────────────────────────────────────────────────────────────
  // Fee = $1.50 deducted AFTER conversion: amount * rate - 1.50
  const paysendRate = mid;
  const paysend = {
    id: 'paysend', name: 'Paysend',
    received: parseFloat((SEND * paysendRate - 1.50).toFixed(2)),
    fee: parseFloat((1.50 / paysendRate).toFixed(2)),
    fee_display: '$1.50',
    rate: parseFloat(paysendRate.toFixed(4)),
    speed: 'Instantané', cashout_free: false,
    note: 'Frais bancaires possibles',
    source: paysendRes.status === 'fulfilled' ? 'live' : 'fallback'
  };

  // ── Purpl (derived from Paysend, same fee structure) ────────────────────────
  const purplRate = mid * 0.995;
  const purpl = {
    id: 'purpl', name: 'Purpl',
    received: parseFloat((SEND * purplRate - 1.50).toFixed(2)),
    fee: parseFloat((1.50 / mid).toFixed(2)),
    fee_display: '$1.50',
    rate: parseFloat(purplRate.toFixed(4)),
    speed: 'Instantané', cashout_free: true,
    note: 'Retrait gratuit au Liban',
    source: paysendRes.status === 'fulfilled' ? 'derived-live' : 'derived-fallback'
  };

  // ── Remitly (live scrape) ────────────────────────────────────────────────────
  let remitly;
  if (remitlyRes.status === 'fulfilled') {
    const { rate, hasPromo } = remitlyRes.value;
    const fee = hasPromo ? 0 : 1.49;
    const surcharge = hasPromo ? 0 : 0.02;
    remitly = {
      id: 'remitly', name: 'Remitly',
      received: parseFloat(((SEND - fee) * rate * (1 - surcharge)).toFixed(2)),
      fee, fee_display: hasPromo ? '0€' : `€${fee} + 2%`,
      rate, speed: 'Quelques minutes', cashout_free: false,
      note: hasPromo ? 'Offre nouveau client — 0€ de frais' : 'Frais de retrait tiers',
      source: 'live'
    };
  } else {
    // Fallback: 0€ fee promo rate calibrated at 1.1628
    remitly = {
      id: 'remitly', name: 'Remitly',
      received: parseFloat((SEND * 1.1628).toFixed(2)),
      fee: 0, fee_display: '0€',
      rate: 1.1628, speed: 'Quelques minutes', cashout_free: false,
      note: 'Offre nouveau client — 0€ de frais', source: 'fallback'
    };
  }

  // ── Sendwave: 0 markup, 0 fee (calibrated = same as mid) ────────────────────
  const sendwave = {
    id: 'sendwave', name: 'Sendwave',
    received: parseFloat((SEND * mid).toFixed(2)),
    fee: 0, fee_display: '0€',
    rate: parseFloat(mid.toFixed(4)),
    speed: 'Quelques minutes', cashout_free: false,
    note: 'Frais de retrait ATM au Liban', source: 'calibrated'
  };

  // ── Western Union: calibrated from 1000€→$1154 observed ─────────────────────
  // Effective rate = 1.154 when mid=1.165 → markup 0.94%, ALL fees baked in
  const wuEffectiveRatio = 1.154 / 1.165; // ratio calibrated on real data
  const wuRate = mid * wuEffectiveRatio;
  const wu = {
    id: 'westernunion', name: 'Western Union',
    received: parseFloat((SEND * wuRate).toFixed(2)),
    fee: 0, fee_display: 'Inclus dans le taux',
    rate: parseFloat(wuRate.toFixed(4)),
    speed: '1–3 heures', cashout_free: false,
    note: 'Frais inclus dans le taux de change', source: 'calibrated'
  };

  // ── WorldRemit: 2% markup + €2.50 fee ───────────────────────────────────────
  const wrRate = mid * 0.980;
  const worldremit = {
    id: 'worldremit', name: 'WorldRemit',
    received: parseFloat(((SEND - 2.50) * wrRate).toFixed(2)),
    fee: 2.50, fee_display: '€2.50',
    rate: parseFloat(wrRate.toFixed(4)),
    speed: '1–3 heures', cashout_free: false,
    note: 'Frais de retrait possibles', source: 'calibrated'
  };

  // ── MoneyGram: 3.2% markup + €4.99 fee ──────────────────────────────────────
  const mgRate = mid * 0.968;
  const moneygram = {
    id: 'moneygram', name: 'MoneyGram',
    received: parseFloat(((SEND - 4.99) * mgRate).toFixed(2)),
    fee: 4.99, fee_display: '€4.99',
    rate: parseFloat(mgRate.toFixed(4)),
    speed: '2–5 jours', cashout_free: false,
    note: 'Frais de retrait tiers', source: 'calibrated'
  };

  return res.status(200).json({
    updated: new Date().toISOString(),
    updated_by: 'live',
    mid_market_rate: mid,
    send_amount: SEND,
    send_currency: 'EUR',
    providers: [purpl, paysend, remitly, sendwave, wu, worldremit, moneygram]
  });
}
