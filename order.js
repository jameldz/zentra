// /api/order — enregistre une commande dans Upstash Redis
// POST  : crée une commande
// GET   : liste toutes les commandes (admin uniquement, sécurisé par header)

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || 'zentra-admin-2026';

async function redisRequest(command, body) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Redis credentials missing');
  const r = await fetch(`${REDIS_URL}/${command}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`Redis error ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  // CORS pour appels client
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const order = req.body || {};
      if (!order.ref || !order.client || !order.tel) {
        return res.status(400).json({ error: 'Champs requis manquants (ref, client, tel)' });
      }
      // Stockage : key = order:<ref>, et indexation par tel client et parrain
      const orderKey = `order:${order.ref}`;
      const orderData = JSON.stringify({
        ...order,
        receivedAt: new Date().toISOString(),
        payee: false,
        paidAt: null
      });

      await redisRequest('set', [orderKey, orderData]);
      // Ajouter à la liste globale ordonnée
      await redisRequest('lpush', ['orders:all', order.ref]);
      // Indexer par téléphone parrain si fourni
      if (order.parrainTel) {
        const cleanTel = String(order.parrainTel).replace(/\s+/g, '').replace(/^0/, '33');
        await redisRequest('sadd', [`parrain:${cleanTel}:filleuls`, order.ref]);
      }
      // Indexer par téléphone client (pour parrain qui chercherait son propre historique)
      const clientTel = String(order.tel).replace(/\s+/g, '').replace(/^0/, '33');
      await redisRequest('sadd', [`client:${clientTel}:commandes`, order.ref]);

      return res.status(200).json({ ok: true, ref: order.ref });
    }

    if (req.method === 'GET') {
      // Admin only — vérifie le header
      const key = req.headers['x-admin-key'] || req.query.key;
      if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

      const list = await redisRequest('lrange', ['orders:all', '0', '100']);
      const refs = list.result || [];
      const orders = [];
      for (const ref of refs) {
        try {
          const got = await redisRequest('get', [`order:${ref}`]);
          if (got.result) orders.push(JSON.parse(got.result));
        } catch (e) { /* skip broken */ }
      }
      return res.status(200).json({ orders });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('order api error', e);
    res.status(500).json({ error: e.message });
  }
}
