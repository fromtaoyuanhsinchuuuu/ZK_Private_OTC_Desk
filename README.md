# ZK-Private OTC Desk

*Compliant, privacy-preserving RFQ trading for institutions.*

---

## Problem

Large institutional orders leak information on public DEXs, causing slippage and MEV, while traditional OTC flows are opaque and rely on manual, trust-based compliance. Compliance teams need evidence that **KYC/AML/Solvency** checks were done—**without** pushing private data or identities on-chain.

**We solve this by:**

* **Gating RFQs** behind three zero-knowledge attestations (**Solvency, KYC, Whitelist**) that are **recorded on-chain** and bound to the RFQ’s `orderHash`.
* Letting market makers see and quote only **OPEN** RFQs (those with on-chain evidence).
* **Atomic settlement** on-chain that re-verifies the three bindings and prevents replay.

Result: private price discovery, **provable compliance**, and trust-minimized settlement with a minimal on-chain footprint (only **bindings**, never PII or balances).

---

## Technology Stack

* **Smart contracts (Foundry / Solidity)**

  * `AttestationRegistry`: `record(attestationId, orderHash)`, `subjectOf(attestationId) → orderHash`
  * `RFQSettlement`: `settleRFQ(...)` verifies 3 bindings + `usedOrder[orderHash]` and atomically swaps assets
* **Off-chain Coordinator (Node.js + viem, port :8080)**

  * Endpoints: `/rfq`, `/prove-and-attest`, `/quote`, `/match`, `/settle`
  * Stores RFQ state machine: `PENDING_ATTESTATION → OPEN → MATCHED → SETTLED`
* **Web UI (Next.js / React, port :3000)**

  * Pages: `/` (Maker: Create RFQ, Prove + Record), `/settle` (Maker/Taker: Quote, Match, Settle)
  * Shows 3 compliance checks via `isValid(attId, orderHash)`
* **Local chain**: Anvil (port :8545, chain-id **1663**)
* **Tokens**: Fixed pair for the MVP: **ETHm / USDC** (addresses in env)
* **(Road to prod)** Horizen **EON** (EVM) + **zkVerify** (managed proof verification) — see Roadmap

---

## Run the Prototype (Local, Mock ZK)

### 0) Prerequisites

* Node.js ≥ 18, `pnpm`
* Foundry (`forge`, `cast`), Anvil
* A terminal that can run three processes (anvil / offchain / web)

### 1) Start a local chain

```bash
anvil --chain-id 1663 --host 127.0.0.1 --port 8545
```

### 2) Deploy contracts

```bash
forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast
```

Copy the printed addresses for:

* `AttestationRegistry`
* `RFQSettlement`
* mock `ETHm` and `USDC` ERC-20s (if your script deploys them)

### 3) Configure environments

Create `offchain/.env`:

```env
# RPC / Chain
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=1663
PRIVATE_KEY=0x<anvil-funded-private-key>

# Contracts
REGISTRY_ADDR=0x<AttestationRegistry>
SETTLEMENT_ADDR=0x<RFQSettlement>

# Fixed pair
USDC_ADDR=0x<USDC>
ETHM_ADDR=0x<ETHm>
STRICT_ADDR=true
```

Create `web/.env.local`:

```env
NEXT_PUBLIC_REGISTRY=0x<AttestationRegistry>
NEXT_PUBLIC_SETTLEMENT=0x<RFQSettlement>
NEXT_PUBLIC_USDC=0x<USDC>
NEXT_PUBLIC_ETHM=0x<ETHm>
NEXT_PUBLIC_EXPLORER_BASE=http://localhost:8545/ # optional placeholder
```

> If you edit `.env`, **restart** the offchain service so it picks up new values.

### 4) Start services

```bash
# Offchain API (port 8080)
pnpm -w --filter offchain dev

# Web UI (port 3000)
pnpm -w --filter web dev
```

### 5) Demo flow (90 seconds)

**Maker (A) on `/`**

1. **Create RFQ** → shows `rfqId`, `orderHash`, status `PENDING_ATTESTATION`.
2. **Prove (mock) + Record** → writes 3 attestations to `AttestationRegistry`
   UI shows three `attestationId`s and flips status to **OPEN**.

**Market Maker (B) on `/settle`**

3. RFQ appears under **Open RFQs** with **3 green checks** (`isValid(attId, orderHash)`).
4. **Quote** → get `quoteId`; **Match** → get `tradeId` (still off-chain).
5. **Settle** → calls `RFQSettlement.settleRFQ(...)`; UI shows `txHash` and **SETTLED**.

### 6) Verify on chain (quick checks)

> The UI exposes “Quick exports”; or use these directly:

```bash
# Receipt must be success (status: 1)
cast receipt <txHash> --rpc-url http://127.0.0.1:8545

# The order cannot be replayed
cast call <RFQSettlement> "usedOrder(bytes32)(bool)" <orderHash> \
  --rpc-url http://127.0.0.1:8545

# Each attestation binds to this order
cast call <AttestationRegistry> "subjectOf(bytes32)(bytes32)" <attestationId> \
  --rpc-url http://127.0.0.1:8545
```

> **Tip:** In the `Settled` event, `orderHash` is the **first 32 bytes** of the event `data` (non-indexed). Make sure you use that exact value when calling `usedOrder(...)`.

### Troubleshooting

* **`addresses invalid / missingEnv: ["USDC_ADDR","ETHM_ADDR"]`**
  Fill `USDC_ADDR` / `ETHM_ADDR` in `offchain/.env`, **restart** the offchain service, then **Reset Demo State** and recreate the RFQ.
* **Open RFQs show `?/?` pair**
  Purely cosmetic parsing; settlement is unaffected as long as addresses are set.
* **Not enough token balances in settlement contract**
  Use `cast send` to top up mock tokens into the settlement contract, then retry **Settle**.

---

## Roadmap

### Going live on **Horizen EON** + **zkVerify**

* **Flip RPC** to EON/Gobi in env; deploy the same contracts there.
* Replace mock `/prove-and-attest` with a **zkVerify relayer**:

  1. `registerVk` (per circuit) → `vkId`
  2. `submitProof(vkId, publicInputs, proofBlob)` → **`jobId`**
  3. Poll `getJob(jobId)` until `status=VERIFIED`
  4. Compute `attestationId = keccak256(jobId)` and call `Registry.record(attestationId, orderHash)` on EON
* UI unchanged, settlement semantics unchanged; explorer shows three `record()` txs and one `settleRFQ()` per trade.

### Product features

* **Enhanced quoting:** multi-maker competitive quotes, **partial fills**, cancel/expire
* **Advanced attestations:** issuer-backed KYC, **best-execution proof**
* **Cross-chain collateral:** start on EON/Gobi, extend to other chains via adapters

### Target outcomes

* Spread improvement **20–40 bps**
* Time-to-fill **< 60s**
* On-chain data exposure limited to **attestationId ↔ orderHash** bindings (no PII)

---

