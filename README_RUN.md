# Run Guide (MVP)

## Prereqs

- Node 18+
- pnpm
- Foundry (anvil, forge)
- Noir toolchain (`noirup`, `nargo`)

## One-time install

```bash
pnpm i -w
```

## Build circuits

```bash
pnpm -w run build:circuits
```

## Start local node (Anvil)

Run Anvil in a separate terminal and keep it running:

```bash
anvil --chain-id 1663 --host 127.0.0.1 --port 8545
```

- Copy the first private key printed by Anvil; we will use it to deploy.
- Optional health check:

```bash
curl -s -X POST http://127.0.0.1:8545 \
	-H 'content-type: application/json' \
	--data '{"jsonrpc":"2.0","id":1,"method":"web3_clientVersion","params":[]}'
```

## Deploy contracts locally

With Anvil running, deploy in a new terminal:

```bash
cd contracts
forge install foundry-rs/forge-std --no-git
# Use the first Anvil private key printed in the Anvil terminal
export PRIVATE_KEY=0x<paste_anvil_private_key_here>
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```
Copy addresses printed (REG/SETTLE/USDC/ETHm) into `.env` at repo root or `offchain/.env`:

```env
RPC_URL=http://127.0.0.1:8545
PRIVATE_KEY=0x...
REGISTRY_ADDR=0x...
SETTLEMENT_ADDR=0x...
PORT=8080
CHAIN_ID=1663
USE_MOCK_ZKVERIFY=true
```

## Start services

```bash
pnpm -w --filter offchain dev
pnpm -w --filter web dev
```

Visit the web app and follow the flow described in the task.

## Tips

- Start anvil with EON Gobi chain id for easier future migration:

```bash
anvil --chain-id 1663
```

- End-to-end smoke test from CLI:

```bash
pnpm -w --filter offchain dev &
pnpm -w --filter web dev &
pnpm -w run e2e
```
