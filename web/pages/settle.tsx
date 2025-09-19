import { useEffect, useState } from 'react';
import { post } from '../lib/api';

export default function Settle(){
  const [tradeId, setTradeId] = useState<string>('');
  const [tx, setTx] = useState<any>(null);
  const [form, setForm] = useState({ rfqId:'', quoteId:'', maker:'0xMaker', taker:'0xTaker', base:'0xUSDC', quote:'0xETHm' });
  const [rfqStatus, setRfqStatus] = useState<string>('PENDING_ATTESTATION');
  const [openList, setOpenList] = useState<any[]>([]);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r1 = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/rfqs?status=OPEN`);
        const list = await r1.json();
        setOpenList(Array.isArray(list) ? list : []);
      } catch {}
      if (form.rfqId) {
        try {
          const r2 = await fetch(`${process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080'}/rfq/${form.rfqId}/status`);
          const s = await r2.json();
          if (s && s.status) setRfqStatus(s.status);
        } catch {}
      }
    }, 2000);
    return () => clearInterval(t);
  }, [form.rfqId]);

  async function quote(){ const q = await post('/quote', { rfqId: form.rfqId, price:'1000000', size:'1000000000000000000', taker: form.taker }); setForm({...form, quoteId: q.quoteId}); }
  async function match(){ const m = await post('/match', { rfqId: form.rfqId, quoteId: form.quoteId }); setTradeId(m.tradeId); }
  async function doSettle(){ const s = await post('/settle', { tradeId, maker: form.maker, taker: form.taker, base: form.base, quote: form.quote }); setTx(s); }

  return (
    <main style={{padding:20}}>
      <h1>Settlement</h1>
      <input placeholder="rfqId" value={form.rfqId} onChange={e=>setForm({...form, rfqId:e.target.value})} />
      <button onClick={quote} disabled={rfqStatus!=='OPEN'}>1) Quote</button>
      <div>RFQ status: {rfqStatus}</div>
      <h3>Open RFQs</h3>
      <ul>
        {openList.map((x:any)=> (
          <li key={x.rfqId}>
            {x.rfqId} — {x.base}/{x.quote} size={x.size}
            <button onClick={()=>setForm({...form, rfqId: x.rfqId})}>Select</button>
          </li>
        ))}
      </ul>
      <div>quoteId: {form.quoteId}</div>
      <button onClick={match}>2) Match</button>
      <div>tradeId: {tradeId}</div>
      <button onClick={doSettle} disabled={!tradeId}>3) Settle</button>
      {tx && <pre>{JSON.stringify(tx,null,2)}</pre>}
    </main>
  );
}
