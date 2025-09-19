const prices: number[] = [];
export function pushPrice(p: number){ prices.push(p); if(prices.length>60) prices.shift(); }
export function getTWAP(){ if(prices.length===0) return 0; return prices.reduce((a,b)=>a+b,0)/prices.length; }
