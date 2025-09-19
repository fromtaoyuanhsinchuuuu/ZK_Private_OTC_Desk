const OFFCHAIN_URL = process.env.NEXT_PUBLIC_OFFCHAIN_URL || 'http://localhost:8080';

export async function post(path: string, body: any){
  const url = `${OFFCHAIN_URL}${path}`;
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }).catch((e)=>{
    throw new Error(`Failed to fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!r.ok) {
    const text = await r.text().catch(()=> '');
    throw new Error(`HTTP ${r.status} ${r.statusText} at ${url}. Body: ${text}`);
  }
  return r.json();
}
