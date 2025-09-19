export type RFQStatus = 'PENDING_ATTESTATION' | 'OPEN' | 'MATCHED' | 'SETTLED';

export type AttMap = Partial<Record<'solvency' | 'kyc' | 'whitelist' | 'bestexec', `0x${string}`>>;

export type Order = {
	rfqId: string;
	orderHash: `0x${string}`;
	maker: string;
	base: string;
	quote: string;
	size: bigint;
	minPrice: bigint;
	expiry: number;
	status: RFQStatus;
	atts?: AttMap;
};

export type Quote = { quoteId: string; rfqId: string; taker: string; price: bigint; size: bigint; validUntil: number };

export type Trade = {
	tradeId: string;
	orderHash: `0x${string}`;
	rfqId: string;
	quoteId: string;
	price: bigint;
	size: bigint;
	atts: AttMap;
};

export const DB = {
	orders: new Map<string, Order>(),
	quotes: new Map<string, Quote>(),
	trades: new Map<string, Trade>(),
};
