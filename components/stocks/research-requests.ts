export async function researchRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(path, { signal });
    if ((response.status === 429 && attempt < 2) || (response.status === 503 && attempt === 0)) {
      const delay = response.status === 429 ? 61_000 : 1800;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, delay);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      });
      continue;
    }
    const payload = await response.json();
    if (!response.ok) throw new ResearchRequestError(response.status, payload.error ?? 'Research data is unavailable.');
    return payload;
  }
}

export class ResearchRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
