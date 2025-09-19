import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { DB, Order, Quote, Trade, AttMap } from './store';
import { orderHash as h, attestationIdFrom } from './hash';
import { submitProof } from './zkverify';
import { recordAttest, settle } from './chain';

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

// Simple request logger for debugging
app.use((req: any, _res: any, next: any) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (_req: any, res: any) => {
  res.json({ ok: true });
});

function isChainReady() {
  const required = ['RPC_URL', 'PRIVATE_KEY', 'REGISTRY_ADDR', 'SETTLEMENT_ADDR'];
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  return { ok: missing.length === 0, missing };
}

app.post('/rfq', async (req: any, res: any)=>{
  const { order } = req.body as { order: Omit<Order,'rfqId'|'orderHash'|'status'> };
  const rfqId = 'rfq_'+Date.now();
  const orderHash = h(order as any) as `0x${string}`;
  const o: Order = {
    rfqId,
    orderHash,
    maker: order.maker,
    base: order.base,
    quote: order.quote,
    size: BigInt(order.size as any),
    minPrice: BigInt(order.minPrice as any),
    expiry: Number(order.expiry as any),
    status: 'PENDING_ATTESTATION',
  } as any;
  DB.orders.set(rfqId, o);
  res.json({ rfqId, orderHash, status: o.status });
});

app.post('/quote', async (req: any, res: any)=>{
  const { rfqId, price, size, taker } = req.body as any;
  const o = DB.orders.get(rfqId);
  if (!o) return res.status(404).json({ error: 'rfq not found' });
  if (o.status !== 'OPEN') return res.status(400).json({ error: 'RFQ not open yet (pending verification)' });
  const q: Quote = { quoteId: 'q_'+Date.now(), rfqId, price: BigInt(price), size: BigInt(size), taker, validUntil: Math.floor(Date.now()/1000)+600 };
  DB.quotes.set(q.quoteId, q);
  res.json(q);
});

app.post('/prove-and-attest', async (req: any, res: any)=>{
  const { rfqId, publicInputs } = req.body as any;
  const o = DB.orders.get(rfqId);
  if (!o) return res.status(404).json({ error: 'rfq not found' });
  const oh = o.orderHash as `0x${string}`;
  const atts: AttMap = {};
  try {
    for (const circuit of ['solvency','kyc','whitelist'] as const){
      const pub = publicInputs?.[circuit];
      if (!pub) return res.status(400).json({ error: `missing public input for ${circuit}` });
      const verificationId = await submitProof(circuit, pub);
      const attId = verificationId as `0x${string}`;
      atts[circuit] = attId;
    }

    // Optionally record on-chain
    const skip = (process.env.SKIP_ONCHAIN || '').toLowerCase() === 'true';
    const ready = isChainReady();
    if (!skip && ready.ok) {
      for (const k of Object.keys(atts) as (keyof AttMap)[]) {
        const attId = atts[k]!;
        await recordAttest(attId, oh);
      }
    } else {
      console.warn('Skipping on-chain recordAttest:', { skip, missing: ready.missing });
    }

    o.atts = atts;
    o.status = 'OPEN';
    res.json({ rfqId, orderHash: oh, status: o.status, attestation: o.atts, onchainRecorded: !skip && ready.ok });
  } catch (e) {
    console.error('prove-and-attest failed:', e);
    res.status(500).json({ error: 'prove-and-attest failed', details: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/match', async (req: any, res: any)=>{
  const { rfqId, quoteId } = req.body as any;
  const o = DB.orders.get(rfqId); const q = DB.quotes.get(quoteId);
  if (!o || !q) return res.status(404).json({ error: 'not found' });
  if (o.status !== 'OPEN') return res.status(400).json({ error: 'RFQ not open' });
  const tradeId = 't_'+Date.now();
  const t: Trade = { tradeId, rfqId, orderHash: o.orderHash, quoteId, price: q.price, size: q.size, atts: o.atts || {} };
  DB.trades.set(tradeId, t);
  o.status = 'MATCHED';
  res.json({ tradeId, orderHash: o.orderHash });
});

app.post('/settle', async (req: any, res: any)=>{
  const { tradeId, maker, taker, base, quote } = req.body as any;
  const t = DB.trades.get(tradeId);
  if (!t) return res.status(404).json({ error: 'trade not found' });
  const oh = t.orderHash as `0x${string}`;
  const atts = (t.atts && Object.keys(t.atts).length ? t.atts : {
    solvency: attestationIdFrom({ oh, circuit: 'solvency' }),
    kyc:      attestationIdFrom({ oh, circuit: 'kyc' }),
    whitelist:attestationIdFrom({ oh, circuit: 'whitelist' })
  }) as AttMap;

  try {
    const skip = (process.env.SKIP_ONCHAIN || '').toLowerCase() === 'true';
    const ready = isChainReady();
    let txHash: string | null = null;
    if (!skip && ready.ok) {
      txHash = await settle({ orderHash: oh as any, atts: atts as any, maker, taker, base, quote, size: t.size, price: t.price }) as any;
    } else {
      txHash = '0x' + 'deadbeef'.repeat(8); // placeholder
      console.warn('Skipping on-chain settle:', { skip, missing: ready.missing });
    }
    const o = DB.orders.get(t.rfqId);
    if (o) o.status = 'SETTLED';
    res.json({ ok: true, txHash });
  } catch (e) {
    console.error('settle failed:', e);
    res.status(500).json({ error: 'settle failed', details: e instanceof Error ? e.message : String(e) });
  }
});

// Query endpoints
app.get('/rfq/:id/status', (req: any, res: any)=>{
  const o = DB.orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  res.json({ rfqId: o.rfqId, orderHash: o.orderHash, status: o.status });
});

app.get('/rfqs', (req: any, res: any)=>{
  const status = (req.query.status as string) || 'OPEN';
  const list = [...DB.orders.values()].filter(x=> x.status === status).map(x=> ({
    rfqId: x.rfqId,
    orderHash: x.orderHash,
    base: x.base,
    quote: x.quote,
    size: x.size.toString(),
    minPrice: x.minPrice.toString(),
    expiry: x.expiry,
    status: x.status,
  }));
  res.json(list);
});

app.get('/rfq/:id/attestations', (req: any, res: any)=>{
  const o = DB.orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  res.json({ orderHash: o.orderHash, atts: o.atts || {} });
});

app.listen(PORT as number, '0.0.0.0', ()=> console.log('offchain listening on', PORT));
