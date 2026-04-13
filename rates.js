// /api/rates.js
// Serves the latest rates from Vercel Blob storage
// Called by the frontend to get live rates

export default async function handler(req, res) {
  try {
    // Fetch the stored rates from Vercel Blob
    const blobUrl = `https://public.blob.vercel-storage.com/rates.json`;

    // Try fetching from blob storage
    const resp = await fetch(blobUrl, {
      headers: { 'Cache-Control': 'no-cache' }
    });

    if (!resp.ok) {
      // Blob doesn't exist yet — return default rates
      throw new Error('Rates not yet generated');
    }

    const data = await resp.json();

    // Serve with CORS and short cache (revalidates every hour)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json');

    return res.status(200).json(data);

  } catch (err) {
    // Fallback: return hardcoded rates if blob isn't available yet
    const fallback = {
      updated: new Date().toISOString(),
      updated_by: 'fallback',
      mid_market_rate: 1.143,
      send_amount: 300,
      send_currency: 'EUR',
      providers: [
        { id: 'purpl',        name: 'Purpl',         received: 339.48, fee: 1.50, speed: 'Instantané',       cashout_free: true,  note: 'Retrait gratuit au Liban'   },
        { id: 'paysend',      name: 'Paysend',        received: 337.77, fee: 1.50, speed: 'Instantané',       cashout_free: false, note: 'Frais bancaires possibles'  },
        { id: 'remitly',      name: 'Remitly',        received: 348.84, fee: 0,    speed: 'Quelques minutes', cashout_free: false, note: 'Offre nouveau client — 0€ de frais' },
        { id: 'worldremit',   name: 'WorldRemit',     received: 333.24, fee: 2.50, speed: '1–3 heures',       cashout_free: false, note: 'Frais de retrait possibles'  },
        { id: 'sendwave',     name: 'Sendwave',       received: 342.90, fee: 0,    speed: 'Quelques minutes', cashout_free: false, note: 'Frais de retrait ATM au Liban'},
        { id: 'westernunion', name: 'Western Union',  received: 327.85, fee: 4.90, speed: '1–3 heures',       cashout_free: false, note: 'Frais de retrait tiers'      },
        { id: 'moneygram',    name: 'MoneyGram',      received: 326.41, fee: 4.99, speed: '2–5 jours',        cashout_free: false, note: 'Frais de retrait tiers'      }
      ]
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(fallback);
  }
}
