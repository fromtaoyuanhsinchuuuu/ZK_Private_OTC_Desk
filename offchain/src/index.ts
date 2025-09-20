import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
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

// Expose config so the frontend can prefill addresses
app.get('/config', (_req: any, res: any) => {
  res.json({
    maker: process.env.DEMO_MAKER || '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    taker: process.env.DEMO_TAKER || '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    usdc: process.env.USDC_ADDR || '',
    ethm: process.env.ETHM_ADDR || '',
    registry: process.env.REGISTRY_ADDR || '',
    settlement: process.env.SETTLEMENT_ADDR || '',
    symbols: {
      [String(process.env.USDC_ADDR || '').toLowerCase()]: 'USDC',
      [String(process.env.ETHM_ADDR || '').toLowerCase()]: 'ETHm',
    }
  });
});

function isChainReady() {
  const required = ['RPC_URL', 'PRIVATE_KEY', 'REGISTRY_ADDR', 'SETTLEMENT_ADDR'];
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  return { ok: missing.length === 0, missing };
}

function isHex20(addr: string | undefined): addr is `0x${string}` {
  return !!addr && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function withFallback(addr: string | undefined, kind: 'maker'|'taker'|'base'|'quote') : `0x${string}` | null {
  // Map kind to env fallback
  const envMap: Record<typeof kind, string | undefined> = {
    maker: process.env.DEMO_MAKER,
    taker: process.env.DEMO_TAKER,
    // Fixed pair convention: base=ETHm, quote=USDC
    base: process.env.ETHM_ADDR,
    quote: process.env.USDC_ADDR,
  } as const;
  if (isHex20(addr)) return addr;
  const fb = envMap[kind];
  if (isHex20(fb)) {
    console.warn(`[settle] ${kind} invalid (${addr}); defaulting to ${fb}`);
    return fb;
  }
  return null;
}

app.post('/rfq', async (req: any, res: any)=>{
  const { order } = req.body as { order: Omit<Order,'rfqId'|'orderHash'|'status'> };
  const rfqId = 'rfq_'+Date.now();
  const strict = (process.env.STRICT_ADDR || '').toLowerCase() === 'true';
  // Sanitize maker; tokens are forced to ETHm/USDC from env
  let maker = order.maker;
  if (!isHex20(maker)) {
    if (strict) return res.status(400).json({ error: 'invalid maker address', hint: 'Set a valid 0x...40-hex value or configure DEMO_MAKER env' });
    maker = (process.env.DEMO_MAKER || '0x70997970c51812dc3a010c7d01b50e0d17dc79c8') as any;
    console.warn('rfq: invalid maker provided; defaulting to DEMO_MAKER');
  }
  // Force fixed pair: maker sells ETHm (base), taker pays USDC (quote)
  let base = process.env.ETHM_ADDR as any;   // ETHm
  let quote = process.env.USDC_ADDR as any;  // USDC
  if (!isHex20(base) || !isHex20(quote)) {
    if (strict) return res.status(400).json({ error: 'token addresses not configured', missingEnv: [!isHex20(base)?'ETHM_ADDR':null, !isHex20(quote)?'USDC_ADDR':null].filter(Boolean) });
    if (!isHex20(base)) console.warn('rfq: ETHM_ADDR missing/invalid; set it in .env');
    if (!isHex20(quote)) console.warn('rfq: USDC_ADDR missing/invalid; set it in .env');
  }
  const safeOrder = { ...order, maker, base, quote } as any;
  const orderHash = h(safeOrder as any) as `0x${string}`;
  const o: Order = {
    rfqId,
    orderHash,
    maker: maker as any,
    base: base as any,
    quote: quote as any,
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
  const id = (rfqId ?? '').toString().trim();
  const o = DB.orders.get(id);
  if (!o) {
    console.warn('quote: rfq not found', { rfqId: id, known: Array.from(DB.orders.keys()) });
    return res.status(404).json({ error: 'rfq not found' });
  }
  if (o.status !== 'OPEN') return res.status(400).json({ error: 'RFQ not open yet (pending verification)' });
  // Validate taker using candidate -> env fallback, otherwise return actionable error
  const tCandidate = ((taker ?? '').toString().trim());
  const takerAddr = withFallback(tCandidate, 'taker');
  if (!takerAddr) {
    return res.status(400).json({ error: 'invalid taker address', hint: 'Pass a valid 0x...40-hex address in body.taker or set DEMO_TAKER in offchain env' });
  }
  const q: Quote = { quoteId: 'q_'+Date.now(), rfqId: id, price: BigInt(price), size: BigInt(size), taker: takerAddr, validUntil: Math.floor(Date.now()/1000)+600 };
  DB.quotes.set(q.quoteId, q);
  // Avoid BigInt serialization error in JSON
  res.json({
    quoteId: q.quoteId,
    rfqId: q.rfqId,
    taker: q.taker,
    price: q.price.toString(),
    size: q.size.toString(),
    validUntil: q.validUntil,
  });
});

app.post('/prove-and-attest', async (req: any, res: any)=>{
  const { rfqId, publicInputs } = req.body as any;
  const o = DB.orders.get(rfqId);
  if (!o) return res.status(404).json({ error: 'rfq not found' });
  const oh = o.orderHash as `0x${string}`;
  const atts: AttMap = {};
  try {
    // If attestations already exist for this RFQ, return them (idempotent)
    if (o.atts && Object.keys(o.atts).length) {
      o.status = 'OPEN';
      return res.json({ rfqId, orderHash: oh, status: o.status, attestation: o.atts, onchainRecorded: true });
    }
      for (const circuit of ['solvency','kyc','whitelist'] as const){
        const pub = publicInputs?.[circuit];
      if (!pub) return res.status(400).json({ error: `missing public input for ${circuit}` });
        // Ensure attestations are unique per order by binding orderHash when deriving the ID
        const boundPub = { ...(pub as any), order_hash: (pub as any)?.order_hash ?? oh, rfq_id: rfqId };
        const verificationId = await submitProof(circuit, boundPub);
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
  const id = (rfqId ?? '').toString().trim();
  const o = DB.orders.get(id); const q = DB.quotes.get(quoteId);
  if (!o || !q) return res.status(404).json({ error: 'not found' });
  if (o.status !== 'OPEN') return res.status(400).json({ error: 'RFQ not open' });
  const tradeId = 't_'+Date.now();
  const t: Trade = { tradeId, rfqId: id, orderHash: o.orderHash, quoteId, price: q.price, size: q.size, atts: o.atts || {} };
  DB.trades.set(tradeId, t);
  o.status = 'MATCHED';
  res.json({ tradeId, orderHash: o.orderHash });
});

app.post('/settle', async (req: any, res: any)=>{
  const { tradeId } = req.body as any;
  const t = DB.trades.get(tradeId);
  if (!t) return res.status(404).json({ error: 'trade not found' });
  const oh = t.orderHash as `0x${string}`;
  // Resolve addresses from stored data
  const order = DB.orders.get(t.rfqId);
  const quoteRow = DB.quotes.get(t.quoteId);
  if (!order || !quoteRow) return res.status(400).json({ error: 'order/quote not found for this trade' });
  // Be defensive: if old RFQs used placeholders like 0xMaker/0xUSDC, fix them up here
  const maker = withFallback(order.maker, 'maker');
  const taker = withFallback(quoteRow.taker, 'taker');
  const base  = withFallback(order.base, 'base');
  const quote = withFallback(order.quote, 'quote');
  if (!maker || !taker || !base || !quote) {
    const missingEnv: string[] = [];
    if (!maker) missingEnv.push('DEMO_MAKER');
    if (!taker) missingEnv.push('DEMO_TAKER');
    if (!base)  missingEnv.push('ETHM_ADDR');
    if (!quote) missingEnv.push('USDC_ADDR');
    return res.status(400).json({
      error: 'addresses invalid',
      rfqId: t.rfqId,
      hint: 'One or more addresses are invalid and no valid fallbacks were configured. Set the missing env vars and recreate the RFQ or enable STRICT_ADDR to fail early.',
      missingEnv,
    });
  }
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
    console.log('settle txHash:', txHash);
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
    pair: `${x.base}/${x.quote}`
  }));
  res.json(list);
});

app.get('/rfq/:id/attestations', (req: any, res: any)=>{
  const o = DB.orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  res.json({ orderHash: o.orderHash, atts: o.atts || {} });
});

// Debug helper: inspect RFQ full details
app.get('/rfq/:id/details', (req: any, res: any)=>{
  const o = DB.orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  res.json({
    rfqId: o.rfqId,
    orderHash: o.orderHash,
    maker: o.maker,
    base: o.base,
    quote: o.quote,
    size: o.size.toString(),
    minPrice: o.minPrice.toString(),
    expiry: o.expiry,
    status: o.status,
    atts: o.atts || {}
  });
});

app.listen(PORT as number, '0.0.0.0', ()=> console.log('offchain listening on', PORT));

// Admin: reset in-memory DB for demos
app.post('/admin/reset', (_req: any, res: any) => {
  const counts = { orders: DB.orders.size, quotes: DB.quotes.size, trades: DB.trades.size };
  DB.orders.clear();
  DB.quotes.clear();
  DB.trades.clear();
  res.json({ ok: true, cleared: counts });
});

// Admin: set token addresses into .env and return the new values
function upsertEnv(vars: Record<string, string>) {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { content = ''; }
  const lines = content.split(/\r?\n/);
  const map = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  for (const [k, v] of Object.entries(vars)) map.set(k, v);
  const next = Array.from(map.entries()).map(([k,v])=>`${k}=${v}`).join('\n')+"\n";
  fs.writeFileSync(envPath, next, 'utf8');
  return { path: envPath, content: next };
}

app.post('/admin/set-env-tokens', (req: any, res: any) => {
  const { usdc, ethm } = req.body as { usdc?: string; ethm?: string };
  if (!isHex20(usdc || '')) return res.status(400).json({ error: 'invalid USDC address' });
  if (!isHex20(ethm || '')) return res.status(400).json({ error: 'invalid ETHm address' });
  const result = upsertEnv({ USDC_ADDR: usdc!, ETHM_ADDR: ethm! });
  // Reflect into process.env for current process (note: some consumers read only at boot)
  process.env.USDC_ADDR = usdc!;
  process.env.ETHM_ADDR = ethm!;
  res.json({ ok: true, envFile: result.path, requiresRestart: true, usdc: usdc, ethm: ethm });
});

// Admin: take token addresses from a specific RFQ and persist to .env
app.post('/admin/autoset-env-tokens-from-rfq', (req: any, res: any) => {
  const { rfqId } = req.body as { rfqId: string };
  const o = DB.orders.get(String(rfqId));
  if (!o) return res.status(404).json({ error: 'rfq not found' });
  const { base, quote } = o;
  if (!isHex20(base) || !isHex20(quote)) return res.status(400).json({ error: 'rfq has invalid base/quote addresses' });
  // Persist following the fixed pair convention: base=ETHm, quote=USDC
  const result = upsertEnv({ ETHM_ADDR: base, USDC_ADDR: quote });
  process.env.ETHM_ADDR = base;
  process.env.USDC_ADDR = quote;
  res.json({ ok: true, envFile: result.path, ethm: base, usdc: quote, requiresRestart: true });
});

// Log important env on startup for quick diagnostics
console.log('[boot] TOKENS', { ETHM_ADDR: process.env.ETHM_ADDR, USDC_ADDR: process.env.USDC_ADDR });
