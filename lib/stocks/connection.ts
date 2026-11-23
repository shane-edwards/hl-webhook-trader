import { z } from 'zod';
import { decrypt } from '@/lib/encryption';
import { EtoroClient } from './etoro';

export const Credentials = z.object({
  apiKey: z.string().trim().min(8).max(3000).regex(/^[\x21-\x7e]+$/),
  userKey: z.string().trim().min(8).max(3000).regex(/^[\x21-\x7e]+$/),
  environment: z.enum(['demo', 'real']),
});

export function etoroFromConnection(row: { credentials_encrypted: string; environment: string }) {
  return new EtoroClient(Credentials.parse({ ...JSON.parse(decrypt(row.credentials_encrypted)), environment: row.environment }));
}
