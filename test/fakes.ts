import type { KeyValue } from "../src/env";

export class MemoryKv implements KeyValue {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  writes = 0;

  async get(key: string) {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.writes++;
    this.data.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }

  async delete(key: string) {
    this.data.delete(key);
  }

  async list({ prefix }: { prefix: string }) {
    return { keys: [...this.data.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })) };
  }
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

type Route = (request: RecordedRequest) => Response | Promise<Response>;

/** A fetch fake that records requests and answers with the first route whose key matches "METHOD url-prefix". */
export function fakeFetch(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? "" : String(init.body),
    };
    requests.push(request);
    const route = Object.entries(routes).find(([key]) => {
      const [method, prefix] = key.split(" ");
      return request.method === method && request.url.startsWith(prefix!);
    });
    if (!route) throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    return route[1](request);
  };
  return { fetch: fn as typeof fetch, requests };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
