import { useEffect, useMemo, useState } from 'react';
import { post } from '../lib/api';
import { labelPair } from '../lib/tokens';
import { getTokenMeta } from '../lib/erc20Meta';
import { DEFAULT_ETHM_ADDR, DEFAULT_USDC_ADDR } from '../lib/addresses';

export default function Home(){
  const [rfq, setRfq] = useState<any>(null);
  const [showAdv, setShowAdv] = useState(false);
  const [cfg, setCfg] = useState<any>(null);
  const [order, setOrder] = useState({
    maker: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    base: '',
    quote: '',
    size: '1000000000000000000',
    minPrice: '1000000',
    expiry: Math.floor(Date.now()/1000)+30
  });
  const [pairNice, setPairNice] = useState<{base?:string;quote?:string}>({});
  const [takerDisplay, setTakerDisplay] = useState<string>('');
  const [whitelist, setWhitelist] = useState<string[]>([]);

  // Prefill maker/base/quote from backend /config so users don't submit placeholders
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/config`);
        const c = await r.json();
        setCfg(c);
        const next = { ...order } as any;
        if (c?.maker) next.maker = c.maker;
        // Fixed pair convention: base=ETHm, quote=USDC
        if (c?.ethm) next.base = c.ethm;
        if (c?.usdc) next.quote = c.usdc;
        setOrder(next);
        if (c?.taker) setTakerDisplay(c.taker);
        next.expiry = Math.floor(Date.now()/1000)+30;
        if (Array.isArray(c?.whitelist)) setWhitelist(c.whitelist);
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

  async function createRFQ(){
    const freshExpiry = Math.floor(Date.now()/1000)+30;
    setOrder((prev) => ({ ...prev, expiry: freshExpiry }));
    const res = await post('/rfq', { order: { ...order, expiry: freshExpiry } });
    setRfq(res);
  }

  async function proveAndAttest(){
    if (!rfq) return;
    const publicInputs = {
      solvency: { commitment: '0x01', order_hash: rfq.orderHash },
      kyc: { commitment: '0x02', now_ts: Math.floor(Date.now()/1000), max_age_secs: 365*24*3600 },
      whitelist: { merkle_root: '0x03' }
    };
    try {
      const res = await post('/prove-and-attest', { rfqId: rfq.rfqId, publicInputs });
      setRfq(res);
    } catch (error:any) {
      const message = error?.message || 'Failed to record attestations';
      if (typeof window !== 'undefined') window.alert(message);
      console.error(message);
    }
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
          expiry: Math.floor(Date.now()/1000)+30,
        }));
      } catch {}
    }
  }

  function copy(text?: string){ if (!text) return; navigator.clipboard?.writeText(text); }

  function switchMaker(address: string){
    if (!address) return;
    setOrder((prev) => ({ ...prev, maker: address }));
    setRfq(null);
  }

  const whitelistSet = useMemo(() => new Set(whitelist.map((addr) => addr.toLowerCase())), [whitelist]);
  const makerOptions = useMemo(() => {
    const candidates: string[] = [];
    const push = (addr: unknown) => {
      if (typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)) candidates.push(addr);
    };
    if (Array.isArray(cfg?.demoAccounts)) cfg.demoAccounts.forEach(push);
    push(cfg?.maker);
    push(cfg?.makerAlt);
    if (!candidates.length) {
      candidates.push('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
      candidates.push('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
    }
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const addr of candidates) {
      const lower = addr.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      uniq.push(addr);
      if (uniq.length === 2) break;
    }
    if (uniq.length === 1) {
      const fallback = uniq[0].toLowerCase() === '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
        ? '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
        : '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
      if (!seen.has(fallback.toLowerCase())) uniq.push(fallback);
    }
    return uniq.map((address, idx) => ({
      address,
      lower: address.toLowerCase(),
      isWhitelisted: whitelistSet.has(address.toLowerCase()),
      rank: idx
    }));
  }, [cfg?.demoAccounts, cfg?.maker, cfg?.makerAlt, whitelistSet]);

  return (
    <main style={{padding:20}}>
      <h1>ZK-Private OTC — Noir MVP</h1>
      <div style={{display:'flex', gap:8, alignItems:'center'}}>
        <button onClick={resetDemo}>Reset Demo State</button>
        <span style={{fontSize:12,color:'#666'}}>Clears in-memory RFQs/quotes/trades on the server</span>
      </div>
      <button onClick={createRFQ}>1) Create RFQ</button>
      <div style={{marginTop:8}}>
        {makerOptions.length > 0 && (
          <div style={{marginBottom:12, padding:12, border:'1px solid #e2e8f0', borderRadius:12, background:'#f8fafc'}}>
            <div style={{fontWeight:600, marginBottom:8}}>Pick a maker persona for the demo</div>
            <div style={{display:'flex', flexWrap:'wrap', gap:8}}>
              {makerOptions.map(({ address, lower, isWhitelisted, rank }) => {
                const selected = order.maker?.toLowerCase() === lower;
                const label = rank === 0 ? 'Maker 1' : rank === 1 ? 'Maker 2' : `Maker ${rank + 1}`;
                return (
                  <button
                    key={address}
                    onClick={() => switchMaker(address)}
                    disabled={selected}
                    style={{
                      padding:'8px 12px',
                      borderRadius:10,
                      border:selected ? '2px solid #2563eb' : '1px solid #cbd5f5',
                      background:selected ? 'rgba(37,99,235,0.12)' : '#fff',
                      cursor:selected ? 'default' : 'pointer',
                      display:'flex',
                      flexDirection:'column',
                      alignItems:'flex-start',
                      minWidth:220
                    }}
                  >
                    <span style={{fontWeight:600}}>{label}</span>
                    <span style={{fontFamily:'monospace', fontSize:12, color:'#475569'}}>{address}</span>
                    <span style={{
                      marginTop:4,
                      fontSize:11,
                      color:isWhitelisted ? '#047857' : '#b91c1c',
                      fontWeight:500
                    }}>
                      {isWhitelisted ? 'Whitelist ✅' : 'Not whitelisted'}
                    </span>
                    {selected && (
                      <span style={{marginTop:4, fontSize:11, color:'#2563eb'}}>Currently controlling this maker</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
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
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <div>orderHash: {rfq.orderHash}</div>
              <button onClick={()=>copy(rfq.orderHash)}>Copy ORDER_HASH</button>
            </div>
            <div style={{marginTop:6}}>
              <b>Tokens</b>
              <div>Base (ETHm): <code>{order.base || DEFAULT_ETHM_ADDR}</code></div>
              <div>Quote (USDC): <code>{order.quote || DEFAULT_USDC_ADDR}</code></div>
            </div>
            {cfg?.registry && (
              <div style={{marginTop:6, display:'flex', alignItems:'center', gap:8}}>
                <div>Registry: <code>{cfg.registry}</code></div>
                <button onClick={()=>copy(cfg.registry)}>Copy REG</button>
              </div>
            )}
            {rfq.attestation && <>
              <h3>Attestations</h3>
              <div>
                {Object.entries(rfq.attestation).map(([k,v]: any) => (
                  <div key={k} style={{display:'flex', alignItems:'center', gap:8}}>
                    <code>{k}:</code>
                    <code>{String(v)}</code>
                    <button onClick={()=>copy(String(v))}>Copy ATTEST ({k})</button>
                  </div>
                ))}
              </div>
              <pre style={{marginTop:8}}>{JSON.stringify(rfq.attestation,null,2)}</pre>
              {/* Quick exports for shell */}
              <div style={{marginTop:8}}>
                <b>Quick exports</b>
                <pre style={{whiteSpace:'pre-wrap'}}>{[
                  `export RPC=${process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545'}`,
                  cfg?.registry ? `export REG=${cfg.registry}` : '# export REG=<registry>' ,
                  `export ORDER=${rfq.orderHash}`,
                  `export ATTEST=${rfq.attestation?.solvency || rfq.attestation?.kyc || rfq.attestation?.whitelist || ''}`,
                  '# Note: TX will be available after Settle on the B page',
                ].join('\n')}</pre>
                <button onClick={()=>{
                  const text = [
                    `export RPC=${process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545'}`,
                    cfg?.registry ? `export REG=${cfg.registry}` : '',
                    `export ORDER=${rfq.orderHash}`,
                    `export ATTEST=${rfq.attestation?.solvency || rfq.attestation?.kyc || rfq.attestation?.whitelist || ''}`,
                  ].filter(Boolean).join('\n');
                  copy(text);
                }}>Copy exports</button>
              </div>
            </>}
          </div>
        )}
      </>}
      {(whitelist.length > 0 || makerOptions.length > 0) && (
        <aside
          style={{
            position: 'fixed',
            right: 20,
            bottom: 20,
            padding: '12px 16px',
            borderRadius: 12,
            background: 'rgba(15, 23, 42, 0.92)',
            color: '#f8fafc',
            fontSize: 12,
            maxWidth: 280,
            boxShadow: '0 12px 24px rgba(15,23,42,0.25)',
            lineHeight: 1.5,
            zIndex: 20
          }}
        >
          <div style={{fontWeight:600, fontSize:13}}>Whitelist roster</div>
          <div style={{marginTop:4, color:'#cbd5f5'}}>Only addresses flagged ✅ pass whitelist verification.</div>
          {makerOptions.length > 0 && (
            <div style={{marginTop:8, display:'flex', flexDirection:'column', gap:6}}>
              {makerOptions.map(({ address, lower, isWhitelisted, rank }) => {
                const isCurrent = order.maker?.toLowerCase() === lower;
                const label = rank === 0 ? 'Maker 1' : rank === 1 ? 'Maker 2' : `Maker ${rank + 1}`;
                return (
                  <div key={address} style={{display:'flex', flexDirection:'column', gap:2}}>
                    <div style={{display:'flex', alignItems:'center', gap:8}}>
                      <span style={{fontWeight:500}}>{label}</span>
                      <code>{address}</code>
                    </div>
                    <div style={{display:'flex', alignItems:'center', gap:8, fontSize:11}}>
                      <span style={{color:isWhitelisted ? '#34d399' : '#f97316'}}>
                        {isWhitelisted ? '✅ In whitelist' : '⚠️ Not in whitelist'}
                      </span>
                      {isCurrent && <span style={{color:'#38bdf8'}}>← current maker</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {whitelist.length > 0 && (
            <div style={{marginTop:12, borderTop:'1px solid rgba(255,255,255,0.08)', paddingTop:10}}>
              <div style={{fontWeight:500, marginBottom:6}}>Whitelist addresses</div>
              <div style={{display:'flex', flexDirection:'column', gap:6}}>
                {whitelist.map((addr) => {
                  const lower = addr.toLowerCase();
                  const isCurrent = order.maker?.toLowerCase() === lower;
                  return (
                    <div key={addr} style={{display:'flex', alignItems:'center', gap:6}}>
                      <code>{addr}</code>
                      {isCurrent && <span style={{color:'#38bdf8'}}>← current maker</span>}
                      <button
                        onClick={() => copy(addr)}
                        style={{
                          border:'none',
                          background:'rgba(255,255,255,0.12)',
                          color:'#f1f5f9',
                          borderRadius:6,
                          padding:'2px 6px',
                          cursor:'pointer'
                        }}
                      >Copy</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      )}
    </main>
  );
}
