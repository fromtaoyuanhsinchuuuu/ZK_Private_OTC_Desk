import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { Hex, concatHex, keccak256, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DB, Order, Quote, Trade, AttMap } from './store';
import { orderHash as h, attestationIdFrom } from './hash';
import { submitProof } from './zkverify';
import {
  recordAttest,
  settle,
  fetchPreflight,
  getDomainSeparator,
  encodeQuote,
  QuoteCommitment
} from './chain';

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

const QUOTE_PRICE_SCALE = 1_000_000n;
const ATTESTATION_TYPE_BY_KEY: Record<'solvency' | 'kyc' | 'whitelist', number> = {
  solvency: 0x02,
  kyc: 0x01,
  whitelist: 0x04
};
const ALLOW_DEMO_UNVERIFIED_SIGNATURES = (process.env.ALLOW_DEMO_UNVERIFIED_SIGNATURES || '').toLowerCase() === 'true';
const SKIP_ONCHAIN_FLAG = (process.env.SKIP_ONCHAIN || '').toLowerCase() === 'true';
const QUOTE_TYPED_TYPES = {
  QuoteCommitment: [
    { name: 'orderHash', type: 'bytes32' },
    { name: 'maker', type: 'address' },
    { name: 'quoteAmount', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'uint256' }
  ]
} as const;
const REQUIRED_ATTEST_MASK =
  ATTESTATION_TYPE_BY_KEY.solvency | ATTESTATION_TYPE_BY_KEY.kyc | ATTESTATION_TYPE_BY_KEY.whitelist;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function computeMask(atts?: AttMap): number {
  if (!atts) return 0;
  let mask = 0;
  if (atts.kyc) mask |= ATTESTATION_TYPE_BY_KEY.kyc;
  if (atts.solvency) mask |= ATTESTATION_TYPE_BY_KEY.solvency;
  if (atts.whitelist) mask |= ATTESTATION_TYPE_BY_KEY.whitelist;
  return mask;
}

function refreshOrderState(order: Order) {
  order.attestMask = computeMask(order.atts);
  if (order.status === 'SETTLED' || order.status === 'CANCELLED') return;
  if (order.status === 'MATCHED') {
    if (order.expiry <= nowSeconds()) order.status = 'EXPIRED';
    return;
  }
  if (order.expiry <= nowSeconds()) {
    order.status = 'EXPIRED';
    return;
  }
  if (order.attestMask === REQUIRED_ATTEST_MASK) {
    order.status = 'OPEN';
  } else {
    order.status = 'PENDING_ATTESTATION';
  }
}

type OrderAction = 'quote' | 'match' | 'settle';

function guardOrder(res: any, order: Order | undefined, action: OrderAction): order is Order {
  if (!order) {
    res.status(404).json({ error: 'rfq not found', code: 'NOT_FOUND' });
    return false;
  }
  refreshOrderState(order);
  if (order.expiry <= nowSeconds()) {
    order.status = 'EXPIRED';
    res.status(400).json({ error: 'RFQ expired', code: 'RFQ_EXPIRED', rfqId: order.rfqId, expiry: order.expiry });
    return false;
  }
  if ((order.attestMask ?? 0) !== REQUIRED_ATTEST_MASK) {
    res.status(400).json({
      error: 'attestations missing',
      code: 'ATTESTATION_MISSING',
      haveMask: order.attestMask ?? 0
    });
    return false;
  }
  if ((action === 'quote' || action === 'match') && order.status !== 'OPEN') {
    res.status(400).json({ error: 'RFQ not open', code: 'NOT_OPEN', status: order.status });
    return false;
  }
  if (action === 'settle' && order.status !== 'MATCHED') {
    res.status(400).json({ error: 'trade not matched', code: 'NOT_MATCHED', status: order.status });
    return false;
  }
  return true;
}

function orderToDto(order: Order) {
  return {
    rfqId: order.rfqId,
    orderHash: order.orderHash,
    base: order.base,
    quote: order.quote,
    size: order.size.toString(),
    minPrice: order.minPrice.toString(),
    expiry: order.expiry,
    status: order.status,
    attestMask: order.attestMask ?? 0
  };
}

// Simple request logger for debugging
app.use((req: any, _res: any, next: any) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (_req: any, res: any) => {
  res.json({ ok: true });
});

// Expose config so the frontend can prefill addresses
const FALLBACK_TAKER_ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const FALLBACK_MAKER_ACCOUNTS: readonly `0x${string}`[] = [
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
] as const;

function parseAddressList(raw: string | undefined): `0x${string}`[] {
  return String(raw || '')
    .split(',')
    .map((addr) => addr.trim())
    .filter((addr) => isHex20(addr)) as `0x${string}`[];
}

type DemoEnvConfig = {
  demoAccounts: `0x${string}`[];
  primary: `0x${string}`;
  secondary: `0x${string}` | '';
  taker: `0x${string}`;
  whitelist: `0x${string}`[];
};

function resolveDemoConfig(): DemoEnvConfig {
  const ordered: `0x${string}`[] = [];
  const addUnique = (addr?: string) => {
    if (!isHex20(addr)) return;
    const cast = addr as `0x${string}`;
    const lower = cast.toLowerCase();
    if (!ordered.some((existing) => existing.toLowerCase() === lower)) {
      ordered.push(cast);
    }
  };

  parseAddressList(process.env.DEMO_ACCOUNTS).forEach(addUnique);
  addUnique(process.env.DEMO_MAKER);
  addUnique(process.env.DEMO_MAKER_ALT);
  FALLBACK_MAKER_ACCOUNTS.forEach(addUnique);

  const primary = ordered[0] ?? FALLBACK_MAKER_ACCOUNTS[0];
  const primaryLower = primary.toLowerCase();
  const secondary = ordered.find((addr) => addr.toLowerCase() !== primaryLower) ?? '';

  const taker = isHex20(process.env.DEMO_TAKER)
    ? process.env.DEMO_TAKER as `0x${string}`
    : FALLBACK_TAKER_ADDR;

  let whitelist = parseAddressList(process.env.WHITELIST_ADDRS);
  if (!whitelist.length) {
    whitelist = ordered.filter((addr) => addr.toLowerCase() !== primaryLower);
    if (!whitelist.length) {
      whitelist = FALLBACK_MAKER_ACCOUNTS.filter((addr) => addr.toLowerCase() !== primaryLower);
    }
  }

  const uniqueWhitelist = whitelist.filter((addr, idx, arr) =>
    arr.findIndex((candidate) => candidate.toLowerCase() === addr.toLowerCase()) === idx
  );

  return {
    demoAccounts: ordered,
    primary,
    secondary,
    taker,
    whitelist: uniqueWhitelist
  };
}

app.get('/config', (_req: any, res: any) => {
  const demo = resolveDemoConfig();

  res.json({
    maker: demo.primary,
    makerAlt: demo.secondary,
    taker: demo.taker,
    usdc: process.env.USDC_ADDR || '',
    ethm: process.env.ETHM_ADDR || '',
    registry: process.env.REGISTRY_ADDR || '',
    settlement: process.env.SETTLEMENT_ADDR || '',
    whitelist: demo.whitelist,
    demoAccounts: demo.demoAccounts,
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

type OnchainMode = { skip: boolean; reason: string | null; ready: ReturnType<typeof isChainReady> };

function resolveOnchainMode(): OnchainMode {
  const ready = isChainReady();
  if (SKIP_ONCHAIN_FLAG) {
    return { skip: true, reason: 'SKIP_ONCHAIN flag enabled', ready };
  }
  if (ALLOW_DEMO_UNVERIFIED_SIGNATURES) {
    return { skip: true, reason: 'demo mode (ALLOW_DEMO_UNVERIFIED_SIGNATURES=true)', ready };
  }
  if (!ready.ok) {
    return { skip: true, reason: `chain config incomplete: ${ready.missing.join(', ')}`, ready };
  }
  return { skip: false, reason: null, ready };
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
    attestMask: 0,
  } as any;
  DB.orders.set(rfqId, o);
  res.json({ rfqId, orderHash, status: o.status });
});

app.post('/quote', async (req: any, res: any)=>{
  const { rfqId, price, size, taker, validUntil, nonce, signature, quoteAmount } = req.body as any;
  const id = (rfqId ?? '').toString().trim();
  const o = DB.orders.get(id);
  if (!o) {
    console.warn('quote: rfq not found', { rfqId: id, known: Array.from(DB.orders.keys()) });
  }
  if (!guardOrder(res, o, 'quote')) return;

  const makerAddr = withFallback(o.maker, 'maker');
  if (!makerAddr) {
    return res.status(400).json({ error: 'maker address unavailable', hint: 'Ensure RFQ was created with a valid maker or DEMO_MAKER env is set' });
  }

  // Validate taker using candidate -> env fallback, otherwise return actionable error
  const tCandidate = ((taker ?? '').toString().trim());
  const takerAddr = withFallback(tCandidate, 'taker');
  if (!takerAddr) {
    return res.status(400).json({ error: 'invalid taker address', hint: 'Pass a valid 0x...40-hex address in body.taker or set DEMO_TAKER in offchain env' });
  }

  if (!ALLOW_DEMO_UNVERIFIED_SIGNATURES) {
    if (signature === undefined || typeof signature !== 'string') {
      return res.status(400).json({ error: 'missing signature', hint: 'Provide the maker-signed EIP-712 quote signature as body.signature' });
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return res.status(400).json({ error: 'invalid signature format', hint: 'Signature must be 65-byte hex string (0x + 130 hex chars)' });
    }
  }

  if (nonce === undefined) {
    return res.status(400).json({ error: 'missing nonce', hint: 'Pass the quote nonce used for signing' });
  }

  if (validUntil === undefined) {
    return res.status(400).json({ error: 'missing validUntil', hint: 'Pass the epoch seconds until which the quote is valid' });
  }

  try {
    const priceBig = BigInt(price);
    const sizeBig = BigInt(size);
    const nonceBig = BigInt(nonce);
    const validUntilNum = Number(validUntil);
    if (!Number.isFinite(validUntilNum) || validUntilNum <= Math.floor(Date.now()/1000)) {
      return res.status(400).json({ error: 'invalid validUntil', hint: 'Use a future unix timestamp in seconds' });
    }

    const expectedQuoteAmount = (sizeBig * priceBig) / QUOTE_PRICE_SCALE;
    const providedQuoteAmount = quoteAmount !== undefined ? BigInt(quoteAmount) : expectedQuoteAmount;
    if (providedQuoteAmount !== expectedQuoteAmount) {
      return res.status(400).json({
        error: 'quoteAmount mismatch',
        expected: expectedQuoteAmount.toString(),
        provided: providedQuoteAmount.toString(),
        hint: 'Ensure quoteAmount = size * price / 1e6 to match on-chain validation'
      });
    }

    const verifyingContract = process.env.SETTLEMENT_ADDR;
    const chainIdRaw = process.env.CHAIN_ID;
    if (!isHex20(verifyingContract)) {
      return res.status(500).json({ error: 'server misconfigured', missingEnv: ['SETTLEMENT_ADDR'] });
    }
    const chainId = chainIdRaw ? Number(chainIdRaw) : NaN;
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return res.status(500).json({ error: 'server misconfigured', missingEnv: ['CHAIN_ID'], hint: 'Set CHAIN_ID to the chain id used by the signer (e.g. 31337 for Anvil)' });
    }

    const commitment = {
      orderHash: o.orderHash,
      maker: makerAddr,
      quoteAmount: expectedQuoteAmount,
      validUntil: BigInt(validUntilNum),
      nonce: nonceBig
    } as const;

    if (!ALLOW_DEMO_UNVERIFIED_SIGNATURES) {
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: 'ZKPrivateOTC',
          version: '1',
          chainId,
          verifyingContract: verifyingContract as `0x${string}`
        },
        types: QUOTE_TYPED_TYPES,
        primaryType: 'QuoteCommitment',
        message: commitment,
        signature: signature as Hex
      });

      if (recovered.toLowerCase() !== makerAddr.toLowerCase()) {
        return res.status(400).json({ error: 'invalid signature', hint: `Recovered ${recovered} expected ${makerAddr}` });
      }
    } else if (!/^0x[0-9a-fA-F]{130}$/.test(signature || '')) {
      console.warn('demo quote: signature missing/invalid, filling zero signature because ALLOW_DEMO_UNVERIFIED_SIGNATURES=true');
    }

    const q: Quote = {
      quoteId: 'q_'+Date.now(),
      rfqId: id,
      taker: takerAddr,
      price: priceBig,
      size: sizeBig,
      validUntil: validUntilNum,
      quoteAmount: expectedQuoteAmount,
      nonce: nonceBig,
      signature: /^0x[0-9a-fA-F]{130}$/.test(signature || '') ? (signature as `0x${string}`) : ('0x' + '00'.repeat(65)) as `0x${string}`
    };

    DB.quotes.set(q.quoteId, q);

    res.json({
      quoteId: q.quoteId,
      rfqId: q.rfqId,
      taker: q.taker,
      price: q.price.toString(),
      size: q.size.toString(),
      validUntil: q.validUntil,
      quoteAmount: q.quoteAmount.toString(),
      nonce: q.nonce.toString(),
      signature: q.signature
    });
  } catch (err) {
    console.error('quote: failed to parse payload', err);
    return res.status(400).json({ error: 'invalid payload', details: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/preflight', async (req: any, res: any)=>{
  const { rfqId, price, size, validUntil, nonce, quoteAmount } = req.body as any;
  const id = (rfqId ?? '').toString().trim();
  const order = DB.orders.get(id);
  if (!order) return res.status(404).json({ error: 'rfq not found', rfqId: id });

  refreshOrderState(order);
  const mask = order.attestMask ?? 0;
  const problems: string[] = [];
  if (order.expiry <= nowSeconds()) problems.push('RFQ expired');
  if (mask !== REQUIRED_ATTEST_MASK) problems.push(`Missing attestations (${mask}/7)`);
  if (order.status !== 'OPEN') problems.push(`Status ${order.status}`);

  const maker = withFallback(order.maker, 'maker');
  if (!maker) {
    return res.status(400).json({ error: 'maker address invalid or missing', rfqId: id, hint: 'Set DEMO_MAKER or include a valid maker when creating the RFQ' });
  }

  if (price === undefined || size === undefined || validUntil === undefined || nonce === undefined) {
    return res.status(400).json({ error: 'missing fields', required: ['price','size','validUntil','nonce'] });
  }

  try {
    const priceBig = BigInt(price);
    const sizeBig = BigInt(size);
    const nonceBig = BigInt(nonce);
    const validUntilNum = Number(validUntil);
    if (!Number.isFinite(validUntilNum) || validUntilNum <= Math.floor(Date.now() / 1000)) {
      return res.status(400).json({ error: 'invalid validUntil', hint: 'Provide a future unix timestamp in seconds' });
    }

    const quoteAmountComputed = (sizeBig * priceBig) / QUOTE_PRICE_SCALE;
    if (quoteAmount !== undefined) {
      const provided = BigInt(quoteAmount);
      if (provided !== quoteAmountComputed) {
        return res.status(400).json({
          error: 'quoteAmount mismatch',
          expected: quoteAmountComputed.toString(),
          provided: provided.toString()
        });
      }
    }
    const quoteAmountValue = quoteAmountComputed;
    const commitment: QuoteCommitment = {
      orderHash: order.orderHash as Hex,
      maker: maker as Hex,
      quoteAmount: quoteAmountValue,
      validUntil: BigInt(validUntilNum),
      nonce: nonceBig
    };

    const [chainInfo, domainSeparator] = await Promise.all([
      fetchPreflight(order.orderHash as Hex, commitment),
      getDomainSeparator()
    ]);

    const encodedQuote = encodeQuote(commitment);
    const digest = keccak256(concatHex(['0x1901', domainSeparator, chainInfo.quoteHash]));

    const chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 0;
    const verifyingContract = process.env.SETTLEMENT_ADDR || '0x0000000000000000000000000000000000000000';

    res.json({
      rfqId: id,
      orderHash: order.orderHash,
      rfqStatus: order.status,
      rfqExpiry: order.expiry,
  attestMask: mask,
      maker,
      price: priceBig.toString(),
      size: sizeBig.toString(),
      quoteAmount: quoteAmountValue.toString(),
      validUntil: validUntilNum,
      nonce: nonceBig.toString(),
      domainSeparator,
      structHash: chainInfo.quoteHash,
      digest,
      attestationMask: chainInfo.mask,
      attestationOk: chainInfo.attestationOk,
      rfqOpen: chainInfo.isOpen,
      orderUsed: chainInfo.usedOrder,
      quoteUsed: chainInfo.usedQuote,
      encodedQuote,
  ok: problems.length === 0,
  problems,
      typedData: {
        domain: {
          name: 'ZKPrivateOTC',
          version: '1',
          chainId,
          verifyingContract
        },
        primaryType: 'QuoteCommitment',
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          QuoteCommitment: [
            { name: 'orderHash', type: 'bytes32' },
            { name: 'maker', type: 'address' },
            { name: 'quoteAmount', type: 'uint256' },
            { name: 'validUntil', type: 'uint64' },
            { name: 'nonce', type: 'uint256' }
          ]
        },
        message: {
          orderHash: order.orderHash,
          maker,
          quoteAmount: quoteAmountValue.toString(),
          validUntil: validUntilNum,
          nonce: nonceBig.toString()
        }
      }
    });
  } catch (err) {
    console.error('preflight failed', err);
    return res.status(400).json({ error: 'invalid payload', details: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/admin/quote-demo', async (req: any, res: any) => {
  const { rfqId, price, size } = req.body as any;
  const id = (rfqId ?? '').toString().trim();
  const order = DB.orders.get(id);
  if (!guardOrder(res, order, 'quote')) return;

  const makerAddr = withFallback(order!.maker, 'maker');
  if (!makerAddr) {
    return res.status(400).json({ error: 'maker address unavailable', code: 'MAKER_ADDR_MISSING' });
  }

  const demoKey = process.env.DEMO_MAKER_KEY ?? process.env.DEMO_MAKER_PRIVKEY;
  if (!demoKey || !/^0x[0-9a-fA-F]{64}$/.test(demoKey)) {
    return res.status(500).json({ error: 'demo signer key not configured', missingEnv: ['DEMO_MAKER_KEY'] });
  }

  const account = privateKeyToAccount(demoKey as Hex);
  if (account.address.toLowerCase() !== makerAddr.toLowerCase()) {
    return res.status(400).json({
      error: 'demo key mismatch',
      hint: `Signer ${account.address} does not match maker ${makerAddr}. Update DEMO_MAKER_KEY or DEMO_MAKER.`,
    });
  }

  const verifyingContract = process.env.SETTLEMENT_ADDR;
  const chainIdRaw = process.env.CHAIN_ID;
  if (!isHex20(verifyingContract)) {
    return res.status(500).json({ error: 'server misconfigured', missingEnv: ['SETTLEMENT_ADDR'] });
  }
  const chainId = chainIdRaw ? Number(chainIdRaw) : NaN;
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return res.status(500).json({ error: 'server misconfigured', missingEnv: ['CHAIN_ID'] });
  }

  try {
    const priceBig = price !== undefined ? BigInt(price) : 1_000_000n;
    const sizeBig = size !== undefined ? BigInt(size) : 1_000_000_000_000_000_000n;
    const expectedQuoteAmount = (sizeBig * priceBig) / QUOTE_PRICE_SCALE;
    const validUntil = Math.floor(Date.now() / 1000) + 60;
    const nonce = BigInt(Date.now());

    const commitment = {
      orderHash: order!.orderHash,
      maker: makerAddr,
      quoteAmount: expectedQuoteAmount,
      validUntil: BigInt(validUntil),
      nonce
    } as const;

    const signature = await account.signTypedData({
      domain: {
        name: 'ZKPrivateOTC',
        version: '1',
        chainId,
        verifyingContract: verifyingContract as `0x${string}`
      },
      types: QUOTE_TYPED_TYPES,
      primaryType: 'QuoteCommitment',
      message: commitment
    });

  const takerCandidate = req.body?.taker ? String(req.body.taker) : undefined;
  const takerAddr = withFallback(takerCandidate, 'taker') || resolveDemoConfig().taker || FALLBACK_TAKER_ADDR;

    const quote: Quote = {
      quoteId: 'q_' + Date.now(),
      rfqId: id,
      taker: takerAddr,
      price: priceBig,
      size: sizeBig,
      validUntil,
      quoteAmount: expectedQuoteAmount,
      nonce,
      signature: signature as `0x${string}`
    };

    DB.quotes.set(quote.quoteId, quote);

    res.json({
      quoteId: quote.quoteId,
      rfqId: quote.rfqId,
      taker: quote.taker,
      price: quote.price.toString(),
      size: quote.size.toString(),
      validUntil: quote.validUntil,
      quoteAmount: quote.quoteAmount.toString(),
      nonce: quote.nonce.toString(),
      signature: quote.signature
    });
  } catch (err) {
    console.error('quote-demo failed', err);
    return res.status(500).json({ error: 'quote-demo failed', details: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/prove-and-attest', async (req: any, res: any)=>{
  const { rfqId, publicInputs } = req.body as any;
  const o = DB.orders.get(rfqId);
  if (!o) return res.status(404).json({ error: 'rfq not found' });
  const oh = o.orderHash as `0x${string}`;
  const atts: AttMap = {};
  try {
    const demoConfig = resolveDemoConfig();
    const whitelistSet = new Set(demoConfig.whitelist.map((addr) => addr.toLowerCase()));
    const makerLower = (o.maker || '').toLowerCase();
    if (!makerLower || !whitelistSet.has(makerLower)) {
      return res.status(403).json({
        error: 'maker not whitelisted',
        code: 'MAKER_NOT_WHITELISTED',
        maker: o.maker
      });
    }
    refreshOrderState(o);
    if (o.status === 'EXPIRED') {
      return res.status(400).json({ error: 'RFQ expired', code: 'RFQ_EXPIRED', rfqId, expiry: o.expiry });
    }
    // If attestations already exist for this RFQ, return them (idempotent)
    if (o.atts && Object.keys(o.atts).length) {
      refreshOrderState(o);
      return res.json({
        rfqId,
        orderHash: oh,
        status: o.status,
        attestation: o.atts,
        attestMask: o.attestMask ?? computeMask(o.atts),
        onchainRecorded: true
      });
    }

    for (const circuit of ['solvency', 'kyc', 'whitelist'] as const) {
      const pub = publicInputs?.[circuit];
      if (!pub) return res.status(400).json({ error: `missing public input for ${circuit}` });
      // Ensure attestations are unique per order by binding orderHash when deriving the ID
      const boundPub = { ...(pub as any), order_hash: (pub as any)?.order_hash ?? oh, rfq_id: rfqId };
      const verificationId = await submitProof(circuit, boundPub);
      const attId = verificationId as `0x${string}`;
      atts[circuit] = attId;
    }

    // Optionally record on-chain
    const onchain = resolveOnchainMode();
    if (!onchain.skip) {
      for (const k of Object.keys(atts) as (keyof AttMap)[]) {
        const attId = atts[k]!;
        const attType = ATTESTATION_TYPE_BY_KEY[k as 'solvency' | 'kyc' | 'whitelist'];
        if (!attType) {
          console.warn('Skipping recordAttest for unsupported circuit key', k);
          continue;
        }
        await recordAttest(attId, oh, attType);
      }
    } else {
      console.warn('Skipping on-chain recordAttest:', { reason: onchain.reason, missing: onchain.ready.missing });
    }

    o.atts = { ...(o.atts || {}), ...atts };
    refreshOrderState(o);
    res.json({
      rfqId,
      orderHash: oh,
      status: o.status,
      attestation: o.atts,
      attestMask: o.attestMask ?? computeMask(o.atts),
      onchainRecorded: !onchain.skip
    });
  } catch (e) {
    console.error('prove-and-attest failed:', e);
    res.status(500).json({ error: 'prove-and-attest failed', details: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/match', async (req: any, res: any)=>{
  const { rfqId, quoteId } = req.body as any;
  const id = (rfqId ?? '').toString().trim();
  const o = DB.orders.get(id);
  if (!guardOrder(res, o, 'match')) return;
  const q = DB.quotes.get(quoteId);
  if (!q) return res.status(404).json({ error: 'quote not found', code: 'QUOTE_NOT_FOUND' });
  const tradeId = 't_'+Date.now();
  const t: Trade = { tradeId, rfqId: id, orderHash: o.orderHash, quoteId, price: q.price, size: q.size, atts: o.atts || {} };
  DB.trades.set(tradeId, t);
  o.status = 'MATCHED';
  refreshOrderState(o);
  res.json({ tradeId, orderHash: o.orderHash });
});

app.post('/settle', async (req: any, res: any)=>{
  const { tradeId } = req.body as any;
  const t = DB.trades.get(tradeId);
  if (!t) return res.status(404).json({ error: 'trade not found' });
  const oh = t.orderHash as `0x${string}`;
  const quoteId = t.quoteId;
  // Resolve addresses from stored data
  const order = DB.orders.get(t.rfqId);
  if (!guardOrder(res, order, 'settle')) return;
  const quoteRow = DB.quotes.get(t.quoteId);
  if (!quoteRow) return res.status(400).json({ error: 'order/quote not found for this trade', code: 'QUOTE_NOT_FOUND' });
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

  const nowSec = Math.floor(Date.now() / 1000);
  if (quoteRow.validUntil <= nowSec) {
    return res.status(400).json({ error: 'quote expired', quoteId, validUntil: quoteRow.validUntil, now: nowSec });
  }

  const expectedQuoteAmount = (t.size * t.price) / QUOTE_PRICE_SCALE;
  if (quoteRow.quoteAmount !== expectedQuoteAmount) {
    return res.status(400).json({
      error: 'quoteAmount mismatch',
      quoteId,
      expected: expectedQuoteAmount.toString(),
      stored: quoteRow.quoteAmount.toString()
    });
  }

  try {
    const onchain = resolveOnchainMode();
    let txHash: string | null = null;
    if (!onchain.skip) {
      if (!quoteRow.signature) {
        return res.status(400).json({ error: 'quote missing signature', quoteId });
      }
      const commitment: QuoteCommitment = {
        orderHash: order.orderHash as Hex,
        maker: maker as Hex,
        quoteAmount: quoteRow.quoteAmount,
        validUntil: BigInt(quoteRow.validUntil),
        nonce: quoteRow.nonce
      };

      const attMap: Record<string, Hex> = {};
      for (const [key, value] of Object.entries(atts)) {
        if (value) attMap[key] = value as Hex;
      }

      txHash = await settle({
        commitment,
        signature: quoteRow.signature,
        atts: attMap,
        taker: taker as Hex,
        base: base as Hex,
        quoteToken: quote as Hex,
        size: t.size,
        price: t.price
      }) as any;
    } else {
      txHash = '0x' + 'deadbeef'.repeat(8); // placeholder
      console.warn('Skipping on-chain settle:', { reason: onchain.reason, missing: onchain.ready.missing });
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
  refreshOrderState(o);
  res.json({ rfqId: o.rfqId, orderHash: o.orderHash, status: o.status });
});

app.get('/rfqs', (req: any, res: any)=>{
  const all = [...DB.orders.values()];
  for (const order of all) refreshOrderState(order);
  const scope = (req.query.visibleFor as string) || '';
  if (scope.toLowerCase() === 'settle') {
    const openCandidates = all.filter((o)=> o.status === 'OPEN');
    const visible = openCandidates.filter((o)=>
      (o.attestMask ?? 0) === REQUIRED_ATTEST_MASK && o.expiry > nowSeconds()
    );
    const hiddenCount = openCandidates.length - visible.length;
    res.json({
      visible: visible.map((o)=> ({
        ...orderToDto(o),
        pair: `${o.base}/${o.quote}`
      })),
      hiddenCount,
      total: all.length
    });
    return;
  }

  const status = (req.query.status as string) || 'OPEN';
  const list = all
    .filter((x)=> x.status === status)
    .map((o)=> ({
      ...orderToDto(o),
      pair: `${o.base}/${o.quote}`
    }));
  res.json(list);
});

app.get('/rfq/:id/attestations', (req: any, res: any)=>{
  const o = DB.orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  refreshOrderState(o);
  res.json({ orderHash: o.orderHash, atts: o.atts || {}, attestMask: o.attestMask ?? 0, status: o.status, expiry: o.expiry });
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
