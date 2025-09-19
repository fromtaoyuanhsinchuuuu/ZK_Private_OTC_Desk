import axios from 'axios';

const api = axios.create({ baseURL: 'http://localhost:8080' });

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function main(){
  console.log('1) RFQ');
  const order = { maker:'0xMaker', base:'0xUSDC', quote:'0xETHm', size: '1000000000000000000', minPrice: '1000000', expiry: Math.floor(Date.now()/1000)+600 };
  const { data: rfq } = await api.post('/rfq', { order });
  console.log('rfq', rfq);

  console.log('2) Prove + Attest (mock)');
  const publicInputs = { solvency:{commitment:'0x01', order_hash: rfq.orderHash}, kyc:{commitment:'0x02', now_ts: Math.floor(Date.now()/1000), max_age_secs: 365*24*3600}, whitelist:{merkle_root:'0x03'} };
  const { data: att } = await api.post('/prove-and-attest', { rfqId: rfq.rfqId, publicInputs });
  console.log('atts', att);

  console.log('3) Quote');
  const { data: q } = await api.post('/quote', { rfqId: rfq.rfqId, price:'1000000', size:'1000000000000000000', taker:'0xTaker' });
  console.log('quote', q);

  console.log('4) Match');
  const { data: m } = await api.post('/match', { rfqId: rfq.rfqId, quoteId: q.quoteId });
  console.log('match', m);

  console.log('5) Settle');
  const { data: s } = await api.post('/settle', { tradeId: m.tradeId, maker:'0xMaker', taker:'0xTaker', base:'0xUSDC', quote:'0xETHm' });
  console.log('settle', s);
}

main().catch(e=>{ console.error(e); process.exit(1); });
