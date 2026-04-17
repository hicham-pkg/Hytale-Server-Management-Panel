import type { HelperOperation } from '../constants';

export interface HelperRequest {
  operation: HelperOperation;
  params: Record<string, unknown>;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface HelperResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}