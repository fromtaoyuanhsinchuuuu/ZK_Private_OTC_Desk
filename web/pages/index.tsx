import { useEffect, useState } from 'react';
import { post } from '../lib/api';
import { labelPair } from '../lib/tokens';
import { checkAtts } from '../lib/verify';
import { getTokenMeta } from '../lib/erc20Meta';
import { DEFAULT_ETHM_ADDR, DEFAULT_USDC_ADDR } from '../lib/addresses';

export default function Home(){
  const [rfq, setRfq] = useState<any>(null);
  const [showAdv, setShowAdv] = useState(false);
  const [order, setOrder] = useState({
    maker: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    base: '',
    quote: '',
    size: '1000000000000000000',
    minPrice: '1000000',
    expiry: Math.floor(Date.now()/1000)+600
  });
  const [pairNice, setPairNice] = useState<{base?:string;quote?:string}>({});
  const [takerDisplay, setTakerDisplay] = useState<string>('');

  // Prefill maker/base/quote from backend /config so users don't submit placeholders
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/config`);
        const c = await r.json();
        const next = { ...order } as any;
        if (c?.maker) next.maker = c.maker;
        // Fixed pair convention: base=ETHm, quote=USDC
        if (c?.ethm) next.base = c.ethm;
        if (c?.usdc) next.quote = c.usdc;
        setOrder(next);
        if (c?.taker) setTakerDisplay(c.taker);
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve dynamic symbols whenever base/quote change
  useEffect(() => {
    (async () => {
      if (!order.base && !order.quote) return;
      try {
        const [bm, qm] = await Promise.all([
          getTokenMeta(order.base),
          getTokenMeta(order.quote)
        ]);
        setPairNice({ base: bm.symbol, quote: qm.symbol });
      } catch {}
    })();
  }, [order.base, order.quote]);

  async function createRFQ(){ const res = await post('/rfq', { order }); setRfq(res); }

  async function proveAndAttest(){
    const publicInputs = {
      solvency: { commitment: '0x01', order_hash: rfq.orderHash },
      kyc: { commitment: '0x02', now_ts: Math.floor(Date.now()/1000), max_age_secs: 365*24*3600 },
      whitelist: { merkle_root: '0x03' }
    };
    const res = await post('/prove-and-attest', { rfqId: rfq.rfqId, publicInputs });
    setRfq(res);
  }

  async function resetDemo(){
    setRfq(null);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/admin/reset`, { method: 'POST' });
    } finally {
      // refresh config defaults
      try {
        const r = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/config`);
        const c = await r.json();
        setOrder((prev) => ({
          ...prev,
          maker: c?.maker || prev.maker,
          // Fixed pair again on refresh
          base: c?.ethm || prev.base,
          quote: c?.usdc || prev.quote,
        }));
      } catch {}
    }
  }

  return (
    <main style={{padding:20}}>
      <h1>ZK-Private OTC — Noir MVP</h1>
      <div style={{display:'flex', gap:8, alignItems:'center'}}>
        <button onClick={resetDemo}>Reset Demo State</button>
        <span style={{fontSize:12,color:'#666'}}>Clears in-memory RFQs/quotes/trades on the server</span>
      </div>
      <button onClick={createRFQ}>1) Create RFQ</button>
      <div style={{marginTop:8}}>
        {/* Show addresses (read-only) */}
        <div>Maker: <code>{order.maker}</code></div>
        <div>Taker: <code>{takerDisplay || process.env.NEXT_PUBLIC_TAKER || '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'}</code></div>
        {/* Tokens are fixed by backend env; show details only in Advanced */}
      </div>
      {rfq && <>
        <div>rfqId: {rfq.rfqId}</div>
        {order.base || order.quote ? (
          <div>Pair: {pairNice.base && pairNice.quote ? `${pairNice.base}/${pairNice.quote}` : labelPair(order.base, order.quote)}</div>
        ) : null}
        <div>Status: {rfq.status || 'UNKNOWN'}</div>
        <button onClick={proveAndAttest} disabled={rfq.status==='OPEN'}>2) Prove (mock) + Record attestation</button>
        <div style={{marginTop:8}}>
          <button onClick={()=>setShowAdv(!showAdv)}>{showAdv ? 'Hide Advanced' : 'Show Advanced'}</button>
        </div>
        {showAdv && (
          <div style={{marginTop:8,border:'1px dashed #999',padding:8}}>
            <div>orderHash: {rfq.orderHash}</div>
            <div style={{marginTop:6}}>
              <b>Tokens</b>
              <div>Base (ETHm): <code>{order.base || DEFAULT_ETHM_ADDR}</code></div>
              <div>Quote (USDC): <code>{order.quote || DEFAULT_USDC_ADDR}</code></div>
            </div>
            {rfq.attestation && <>
              <h3>Attestations</h3>
              <pre>{JSON.stringify(rfq.attestation,null,2)}</pre>
            </>}
          </div>
        )}
      </>}
    </main>
  );
}
