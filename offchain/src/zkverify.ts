import { attestationIdFrom } from "./hash";

async function mockSubmit(circuit: string, body: any){
  // Demo: do not verify proof; just return a deterministic attestId
  return attestationIdFrom({ circuit, body });
}

// Placeholder for real zkVerify integration
async function realSubmit(circuit: string, body: any){
  // TODO: call zkVerify registerVk/submitProof/poll, then derive a bytes32 attestationId
  // For forward-compat, return a deterministic placeholder derived from inputs
  return attestationIdFrom({ circuit, job: 'placeholder', body });
}

export async function submitProof(circuit: string, body: any){
  const useMock = (process.env.USE_MOCK_ZKVERIFY ?? 'true') === 'true';
  return useMock ? mockSubmit(circuit, body) : realSubmit(circuit, body);
}
