import * as http from 'http';
import { computeHmac, generateUuid } from '../utils/crypto';
import { getConfig } from '../config';
import type { HelperOperation, HelperResponse } from '@hytale-panel/shared';

export class HelperUnavailableError extends Error {
  readonly operation: HelperOperation;

  constructor(operation: HelperOperation, message: string) {
    super(message);
    this.name = 'HelperUnavailableError';
    this.operation = operation;
  }
}

export function isHelperUnavailableError(error: unknown): error is HelperUnavailableError {
  return error instanceof HelperUnavailableError;
}

export interface CallHelperOptions {
  timeoutMs?: number;
}

/**
 * Client for communicating with the privileged helper service via Unix socket.
 * All requests are HMAC-signed.
 */
export async function callHelper(
  operation: HelperOperation,
  params: Record<string, unknown> = {},
  options: CallHelperOptions = {}
): Promise<HelperResponse> {
  const config = getConfig();
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 60_000);
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
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as HelperResponse;
            resolve(parsed);
          } catch {
            reject(new HelperUnavailableError(
              operation,
              `Invalid helper response for ${operation}: ${data.slice(0, 200)}`
            ));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new HelperUnavailableError(
        operation,
        `Helper connection failed for ${operation}: ${err.message}. Is the helper service running?`
      ));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new HelperUnavailableError(operation, `Helper request timed out for ${operation}`));
    });

    req.write(body);
    req.end();
  });
}
