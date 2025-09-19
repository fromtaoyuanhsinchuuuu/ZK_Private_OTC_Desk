import { useState } from 'react';
import { post } from '../lib/api';

export default function Home(){
  const [rfq, setRfq] = useState<any>(null);
  const [order, setOrder] = useState({ maker:'0xMaker', base:'0xUSDC', quote:'0xETHm', size: '1000000000000000000', minPrice: '1000000', expiry: Math.floor(Date.now()/1000)+600 });

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

  return (
    <main style={{padding:20}}>
      <h1>ZK-Private OTC — Noir MVP</h1>
      <button onClick={createRFQ}>1) Create RFQ</button>
      {rfq && <>
        <div>rfqId: {rfq.rfqId}</div>
        <div>orderHash: {rfq.orderHash}</div>
        <div>Status: {rfq.status || 'UNKNOWN'}</div>
        <button onClick={proveAndAttest} disabled={rfq.status==='OPEN'}>2) Prove (mock) + Record attestation</button>
        {rfq.attestation && <>
          <h3>Attestations</h3>
          <pre>{JSON.stringify(rfq.attestation,null,2)}</pre>
        </>}
      </>}
    </main>
  );
}
