import { useEffect, useState } from 'react';
import { post } from '../lib/api';
import { checkAtts } from '../lib/verify';
import { labelPair } from '../lib/tokens';
import { getTokenMeta } from '../lib/erc20Meta';
import { DEFAULT_ETHM_ADDR, DEFAULT_USDC_ADDR } from '../lib/addresses';

export default function Settle(){
  const [tradeId, setTradeId] = useState<string>('');
  const [tx, setTx] = useState<any>(null);
  const [form, setForm] = useState({ rfqId:'', quoteId:'' });
  const [rfqStatus, setRfqStatus] = useState<string>('PENDING_ATTESTATION');
  const [openList, setOpenList] = useState<any[]>([]);
  const [err, setErr] = useState<string>('');
  const [adv, setAdv] = useState<boolean>(false);
  const [meta, setMeta] = useState<{orderHash?: string, atts?: any} | null>(null);
  const [compliance, setCompliance] = useState<Record<string, boolean> | null>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [taker, setTaker] = useState<string>('');
  const [pairOverride, setPairOverride] = useState<{base?: string; quote?: string}>({});
  const [envMsg, setEnvMsg] = useState<string>('');
  function copy(text?: string){ if (!text) return; navigator.clipboard?.writeText(text); }


  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/config`);
        const c = await r.json();
        setCfg(c);
        if (c?.taker) setTaker(c.taker);
      } catch {}
    })();
    const t = setInterval(async () => {
      try {
        const r1 = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/rfqs?status=OPEN`);
        const list = await r1.json();
        setOpenList(Array.isArray(list) ? list : []);
      } catch {}
      // no additional defaults needed
      if (form.rfqId) {
        try {
          const r2 = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/rfq/${form.rfqId}/status`);
          const s = await r2.json();
          if (s && s.status) setRfqStatus(s.status);
        } catch {}
        try {
          const r3 = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/rfq/${form.rfqId}/attestations`);
          const m = await r3.json();
          setMeta(m);
          if (m?.orderHash && m?.atts) {
            const chk = await checkAtts(m.orderHash, m.atts);
            if (chk) setCompliance(chk);
          }
          // Resolve symbols for the currently selected RFQ (if available)
          const current = openList.find(x=> x.rfqId === form.rfqId);
          const baseAddr = current?.base; const quoteAddr = current?.quote;
          if (baseAddr && quoteAddr) {
            try {
              const [bm, qm] = await Promise.all([
                getTokenMeta(baseAddr),
                getTokenMeta(quoteAddr)
              ]);
              setPairOverride({ base: bm.symbol, quote: qm.symbol });
            } catch {}
          }
        } catch {}
      }
    }, 2000);
    return () => clearInterval(t);
  }, [form.rfqId]);

  async function quote(){
    setErr('');
    try {
      const usedTaker = (taker || cfg?.taker || process.env.NEXT_PUBLIC_TAKER || '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC').toString();
      const q = await post('/quote', { rfqId: form.rfqId.trim(), price:'1000000', size:'1000000000000000000', taker: usedTaker });
      setForm({...form, quoteId: q.quoteId});
    } catch (e:any) { setErr(e?.message || String(e)); }
  }
  async function resetDemo(){
    setErr(''); setTradeId(''); setTx(null); setForm({rfqId:'', quoteId:''}); setMeta(null); setCompliance(null);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/admin/reset`, { method: 'POST' });
    } catch (e:any) { setErr(e?.message || String(e)); }
  }
  async function match(){
    setErr('');
    try {
      const m = await post('/match', { rfqId: form.rfqId.trim(), quoteId: form.quoteId });
      setTradeId(m.tradeId);
    } catch (e:any) { setErr(e?.message || String(e)); }
  }
  async function doSettle(){
    setErr('');
    try {
      const s = await post('/settle', { tradeId });
      setTx(s);
      // After settle, re-check attestation validity for visual confirmation
      try {
        if (meta?.orderHash && meta?.atts) {
          const chk = await checkAtts(meta.orderHash as `0x${string}` , meta.atts as any);
          if (chk) setCompliance(chk);
        }
      } catch {}
    } catch (e:any) { setErr(e?.message || String(e)); }
  }

  async function persistTokensToEnv(){
    setEnvMsg('');
    try {
      const resp = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/admin/autoset-env-tokens-from-rfq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfqId: form.rfqId.trim() })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'failed');
      setEnvMsg(`Saved to .env: USDC_ADDR=${data.usdc}, ETHM_ADDR=${data.ethm} (restart offchain to apply everywhere)`);
    } catch (e:any) {
      setEnvMsg(`Failed to save tokens to .env: ${e?.message || e}`);
    }
  }

  return (
    <main style={{padding:20}}>
      <h1>Settlement</h1>
      {cfg && (
        <div style={{marginBottom:4}}>
          <div>Maker: <code>{cfg.maker}</code></div>
          <div>Taker: <code>{cfg.taker}</code></div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <div>Registry: <code>{cfg.registry}</code></div>
            <button onClick={()=>copy(cfg.registry)}>Copy REG</button>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <div>Settlement: <code>{cfg.settlement}</code></div>
            <button onClick={()=>copy(cfg.settlement)}>Copy SETTLE</button>
          </div>
        </div>
      )}
      <div style={{display:'flex', gap:8, alignItems:'center'}}>
        <button onClick={resetDemo}>Reset Demo State</button>
        <span style={{fontSize:12,color:'#666'}}>Clears in-memory RFQs/quotes/trades on the server</span>
      </div>
      {form.rfqId && (
        <div style={{display:'flex', gap:8, alignItems:'center', marginTop:8}}>
          <button onClick={persistTokensToEnv} disabled={!form.rfqId}>Persist RFQ tokens to .env</button>
          <span style={{fontSize:12,color:'#666'}}>Writes USDC_ADDR/ETHM_ADDR from selected RFQ to offchain/.env</span>
        </div>
      )}
      {envMsg && <div style={{marginTop:6, fontSize:12, color:'#555'}}>{envMsg}</div>}
      {/* Status banner */}
      <div style={{
        padding:'8px 12px',
        borderRadius:6,
        margin:'8px 0',
        backgroundColor: rfqStatus==='OPEN' ? '#e6ffed' : rfqStatus==='MATCHED' ? '#fff5e6' : rfqStatus==='SETTLED' ? '#e6f0ff' : '#f5f5f5',
        border:'1px solid #ddd'
      }}>
        <b>Status:</b> {rfqStatus}
        <span style={{marginLeft:8, fontSize:12, color:'#666'}}>
          {rfqStatus==='PENDING_ATTESTATION' && 'Waiting for A to Prove + Record'}
          {rfqStatus==='OPEN' && 'RFQ is open; you can Quote/Match now'}
          {rfqStatus==='MATCHED' && 'Trade matched; proceed to Settle'}
          {rfqStatus==='SETTLED' && 'Trade settled on-chain'}
        </span>
      </div>
  <input placeholder="rfqId" value={form.rfqId} onChange={e=>setForm({...form, rfqId:e.target.value})} />
  <button onClick={quote} disabled={rfqStatus!=='OPEN' || !form.rfqId.trim()}>1) Quote</button>
  <div>RFQ status: {rfqStatus}</div>
      <div style={{marginTop:4}}>
        <input placeholder="taker (optional) 0x..." value={taker} onChange={e=>setTaker(e.target.value)} style={{width:420}}/>
        <div style={{fontSize:12, color:'#666'}}>If blank, uses config/env default: {cfg?.taker || process.env.NEXT_PUBLIC_TAKER || '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'}</div>
      </div>
      {form.rfqId && (() => {
        const found = openList.find(x=> x.rfqId===form.rfqId);
        if (!found) return null;
        const fallback = labelPair(found.base, found.quote);
        const nice = pairOverride.base && pairOverride.quote ? `${pairOverride.base}/${pairOverride.quote}` : fallback;
        return <div>Pair: {nice} size={found.size}</div>;
      })()}
  {err && <div style={{color:'crimson'}}>Error: {err}</div>}
      {compliance && (
        <div style={{marginTop:8}}>
          <b>Compliance</b>: 
          <span> Solvency {compliance.solvency ? '✅' : '❌'}</span>{' · '}
          <span> KYC {compliance.kyc ? '✅' : '❌'}</span>{' · '}
          <span> Whitelist {compliance.whitelist ? '✅' : '❌'}</span>
          {tx?.txHash && (
            <span style={{marginLeft:8, color:'#2e7d32'}}>✓ re-checked on-chain after settle</span>
          )}
        </div>
      )}
      <div style={{marginTop:6}}>
        <button onClick={()=>setAdv(!adv)}>{adv ? 'Hide Advanced' : 'Show Advanced'}</button>
      </div>
      {adv && meta && (
        <div style={{border:'1px dashed #999', padding:8, marginTop:8}}>
          <div>orderHash: {meta.orderHash}</div>
          {(() => {
            const found = openList.find(x=> x.rfqId===form.rfqId);
            if (!found) return null;
            return (
              <div style={{marginTop:6}}>
                <b>Tokens</b>
                <div>Base: <code>{found.base || DEFAULT_ETHM_ADDR}</code></div>
                <div>Quote: <code>{found.quote || DEFAULT_USDC_ADDR}</code></div>
              </div>
            );
          })()}
          {meta.atts && <>
            <h4>Attestations</h4>
            <pre>{JSON.stringify(meta.atts, null, 2)}</pre>
          </>}
        </div>
      )}
      <h3>Open RFQs</h3>
      <ul>
        {openList.map((x:any)=> (
          <li key={x.rfqId}>
            {x.rfqId} — Pair: {labelPair(x.base, x.quote)} size={x.size}
            <button onClick={()=>setForm({...form, rfqId: x.rfqId})}>Select</button>
          </li>
        ))}
      </ul>
      <div>quoteId: {form.quoteId}</div>
      <button onClick={match} disabled={!form.quoteId || !!tradeId}>2) Match</button>
      <div>tradeId: {tradeId}</div>
      {/* Token addresses are handled server-side; only require tradeId */}
      <button onClick={doSettle} disabled={!tradeId}>3) Settle</button>
      {tx && (
        <div style={{marginTop:12}}>
          <div>Transaction:</div>
          <pre>{JSON.stringify(tx,null,2)}</pre>
          {tx.txHash && (
            <div style={{marginTop:8}}>
              <div style={{display:'flex', alignItems:'center', gap:8}}>
                <div>txHash: <code>{tx.txHash}</code></div>
                <button onClick={()=> copy(tx.txHash)}>Copy TX</button>
              </div>
              <div style={{marginTop:8}}>
                <b>Quick logs:</b>
                <pre style={{whiteSpace:'pre-wrap'}}>
cast receipt {tx.txHash}
cast tx {tx.txHash}
                </pre>
                <div style={{fontSize:12,color:'#666'}}>Run in your Foundry shell; txHash matches the one printed by the offchain server.</div>
              </div>
              <div style={{fontSize:12, color:'#666'}}>This txHash should match the one printed in the offchain terminal.</div>
              {/* Quick exports so you can paste into shell */}
              {meta?.orderHash && (
                <div style={{marginTop:8}}>
                  <b>Quick exports</b>
                  <pre style={{whiteSpace:'pre-wrap'}}>{[
                    `export RPC=${process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545'}`,
                    cfg?.registry ? `export REG=${cfg.registry}` : '# export REG=<registry>' ,
                    cfg?.settlement ? `export SETTLE=${cfg.settlement}` : '# export SETTLE=<settlement>' ,
                    `export TX=${tx.txHash}`,
                    `export ORDER=${meta.orderHash}`,
                    meta?.atts ? `export ATTEST=${meta.atts?.solvency || meta.atts?.kyc || meta.atts?.whitelist || ''}` : '# export ATTEST=<attestationId>'
                  ].join('\n')}</pre>
                  <button onClick={()=>{
                    const text = [
                      `export RPC=${process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545'}`,
                      cfg?.registry ? `export REG=${cfg.registry}` : '',
                      cfg?.settlement ? `export SETTLE=${cfg.settlement}` : '',
                      `export TX=${tx.txHash}`,
                      `export ORDER=${meta?.orderHash || ''}`,
                      meta?.atts ? `export ATTEST=${meta.atts?.solvency || meta.atts?.kyc || meta.atts?.whitelist || ''}` : '',
                    ].filter(Boolean).join('\n');
                    copy(text);
                  }}>Copy exports</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
