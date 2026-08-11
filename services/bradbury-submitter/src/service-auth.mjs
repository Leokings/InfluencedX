import { SubmitterProblem } from './problem.mjs';

export async function requireServiceAuthorization(request, expectedSecret) {
  const authorization = request.headers.get('authorization');
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) unauthorized();
  const supplied = authorization.slice(prefix.length);
  if (!supplied || !(await constantTimeEqual(supplied, expectedSecret))) unauthorized();
}

async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function unauthorized() {
  throw new SubmitterProblem(401, 'SERVICE_AUTHORIZATION_REQUIRED', 'Private service authorization failed.');
}
