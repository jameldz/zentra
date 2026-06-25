// /api/parrain?tel=06... — renvoie les filleuls + stats d'un parrain

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

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

// Calcul des récompenses
const PRIME_1ER = 500;       // €
const PRIME_CONTAINER = 400; // € par container suivant (sur 12 mois)
const BONUS_PALIERS = { 3: 1500, 5: 3000, 10: 8000 };

function isWithin12Months(firstDateIso, currentDateIso) {
  const first = new Date(firstDateIso).getTime();
  const cur = new Date(currentDateIso).getTime();
  const ms12 = 365.25 * 24 * 3600 * 1000;
  return cur - first < ms12;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let tel = (req.query.tel || '').toString().replace(/\s+/g, '');
    if (!tel) return res.status(400).json({ error: 'Paramètre tel manquant' });
    // Normaliser : 06... → 336... / +33... → 33...
    tel = tel.replace(/^\+/, '').replace(/^0/, '33');

    // Tous les refs des filleuls
    const got = await redisRequest('smembers', [`parrain:${tel}:filleuls`]);
    const refs = got.result || [];

    if (!refs.length) {
      return res.status(200).json({ found: false, message: 'Aucun parrainage trouvé pour ce numéro' });
    }

    // Récupérer chaque commande filleul
    const filleulsByCompany = new Map(); // company -> { firstOrder, orders: [] }
    for (const ref of refs) {
      try {
        const r = await redisRequest('get', [`order:${ref}`]);
        if (!r.result) continue;
        const o = JSON.parse(r.result);
        const company = (o.client || '').trim();
        if (!company) continue;
        if (!filleulsByCompany.has(company)) {
          filleulsByCompany.set(company, { firstOrder: o, orders: [] });
        }
        const entry = filleulsByCompany.get(company);
        entry.orders.push(o);
        // Mettre à jour firstOrder si plus ancien
        if (new Date(o.receivedAt) < new Date(entry.firstOrder.receivedAt)) {
          entry.firstOrder = o;
        }
      } catch (e) { /* skip */ }
    }

    // Calcul crédits
    let totalCredits = 0;
    let filleulsValides = 0; // = nb de SOCIÉTÉS uniques dont au moins 1 commande payée
    let filleulsEnAttente = 0;
    const detailFilleuls = [];
    const now = new Date().toISOString();

    for (const [company, info] of filleulsByCompany) {
      const allOrders = info.orders.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
      const firstPayedOrder = allOrders.find(o => o.payee);
      const firstOrderDate = firstPayedOrder ? firstPayedOrder.paidAt || firstPayedOrder.receivedAt : null;

      let creditsThisFilleul = 0;
      let containersValides = 0;
      let containersEnAttente = 0;
      let isPrimeAcquired = false;

      for (const o of allOrders) {
        const containers = parseInt(o.containers) || 1;
        if (o.payee) {
          // Première commande payée → prime acquisition
          if (!isPrimeAcquired) {
            creditsThisFilleul += PRIME_1ER;
            isPrimeAcquired = true;
            // Containers supplémentaires de cette même commande
            const extra = Math.max(0, containers - 1);
            if (extra > 0 && firstOrderDate && isWithin12Months(firstOrderDate, o.paidAt || o.receivedAt)) {
              creditsThisFilleul += extra * PRIME_CONTAINER;
            }
          } else {
            // Commandes suivantes
            if (firstOrderDate && isWithin12Months(firstOrderDate, o.paidAt || o.receivedAt)) {
              creditsThisFilleul += containers * PRIME_CONTAINER;
            }
          }
          containersValides += containers;
        } else {
          containersEnAttente += containers;
        }
      }

      if (isPrimeAcquired) filleulsValides += 1;
      else filleulsEnAttente += 1;

      totalCredits += creditsThisFilleul;
      detailFilleuls.push({
        company,
        containersValides,
        containersEnAttente,
        credits: creditsThisFilleul,
        firstOrderDate,
        nbCommandes: allOrders.length,
        primeAcquired: isPrimeAcquired,
        within12mo: firstOrderDate ? isWithin12Months(firstOrderDate, now) : true
      });
    }

    // Bonus paliers
    let bonusPaliers = 0;
    const paliersAtteints = [];
    for (const seuil of Object.keys(BONUS_PALIERS).map(Number).sort((a, b) => a - b)) {
      if (filleulsValides >= seuil) {
        bonusPaliers += BONUS_PALIERS[seuil];
        paliersAtteints.push(seuil);
      }
    }
    totalCredits += bonusPaliers;

    // Statut
    let statut = '';
    if (filleulsValides >= 10) statut = '💎 Prestige';
    else if (filleulsValides >= 5) statut = '🥇 Gold';
    else if (filleulsValides >= 3) statut = '🤝 Partenaire';
    else statut = '🌱 Apporteur d\'affaires';

    // Récup nom parrain (depuis sa propre commande s'il en a faite)
    let parrainNom = '';
    let parrainCompany = '';
    try {
      const gotClient = await redisRequest('smembers', [`client:${tel}:commandes`]);
      const refsClient = gotClient.result || [];
      if (refsClient.length > 0) {
        const oRes = await redisRequest('get', [`order:${refsClient[0]}`]);
        if (oRes.result) {
          const oc = JSON.parse(oRes.result);
          parrainNom = oc.contact || '';
          parrainCompany = oc.client || '';
        }
      }
    } catch (e) { /* skip */ }

    return res.status(200).json({
      found: true,
      tel,
      parrainNom,
      parrainCompany,
      statut,
      filleulsValides,
      filleulsEnAttente,
      totalCredits,
      bonusPaliers,
      paliersAtteints,
      paliersSuivants: Object.keys(BONUS_PALIERS).map(Number).filter(n => n > filleulsValides),
      filleuls: detailFilleuls
    });
  } catch (e) {
    console.error('parrain api error', e);
    res.status(500).json({ error: e.message });
  }
}
