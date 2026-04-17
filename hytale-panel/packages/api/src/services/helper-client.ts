import * as http from 'http';
import { computeHmac, generateUuid } from '../utils/crypto';
import { getConfig } from '../config';
import type { HelperOperation, HelperResponse } from '@hytale-panel/shared';

/**
 * Client for communicating with the privileged helper service via Unix socket.
 * All requests are HMAC-signed.
 */
export async function callHelper(
  operation: HelperOperation,
  params: Record<string, unknown> = {}
): Promise<HelperResponse> {
  const config = getConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateUuid();
  const paramsStr = JSON.stringify(params);
  const signature = computeHmac(config.helperHmacSecret, operation, paramsStr, timestamp, nonce);

  const body = JSON.stringify({
    operation,
    params,
    timestamp,
    nonce,
    signature,
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config.helperSocketPath,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 60_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as HelperResponse;
            resolve(parsed);
          } catch {
            reject(new Error(`Invalid helper response: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`Helper connection failed: ${err.message}. Is the helper service running?`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Helper request timed out'));
    });

    req.write(body);
    req.end();
  });
}