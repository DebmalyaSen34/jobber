import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { LookupFunction } from "node:net";
import { RetrievalError, USER_AGENT } from "./types.js";
import type { Address } from "./policy.js";

export type HttpResponse = { status: number; headers: Record<string, string>; text: string };
export type TransportOptions = {
  deadline: number;
  maxBytes: number;
  maxDecodedBytes: number;
  contentTypes: readonly string[];
};
export type Transport = (url: URL, address: Address, options: TransportOptions) => Promise<HttpResponse>;

export function decodeBody(body: Buffer, encoding: string, maxBytes: number): string {
  let decoded: Buffer;
  try {
    switch (encoding.toLowerCase()) {
      case "": case "identity": decoded = body; break;
      case "gzip": decoded = gunzipSync(body, { maxOutputLength: maxBytes }); break;
      case "deflate": decoded = inflateSync(body, { maxOutputLength: maxBytes }); break;
      case "br": decoded = brotliDecompressSync(body, { maxOutputLength: maxBytes }); break;
      default: throw new RetrievalError("UNSUPPORTED_ENCODING", "Unsupported content encoding.");
    }
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    const code = error instanceof Error && "code" in error ? error.code : "";
    throw new RetrievalError(code === "ERR_BUFFER_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_ENCODING", "Compressed response could not be safely decoded.");
  }
  if (decoded.length > maxBytes) throw new RetrievalError("BODY_TOO_LARGE", "Decoded body exceeds the limit.");
  return decoded.toString("utf8");
}

/** No second DNS lookup, pooled socket, proxy environment, cookies, or automatic redirect. */
export const requestPinned: Transport = (url, address, options) => new Promise((resolve, reject) => {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) { reject(new RetrievalError("TIMEOUT", "Fetch deadline exceeded.")); return; }
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => callback(null, address.address, address.family);
  const request = (url.protocol === "https:" ? https : http).request(url, {
    method: "GET", agent: false, lookup: pinnedLookup, family: address.family,
    headers: { "user-agent": USER_AGENT, accept: options.contentTypes.join(", "), "accept-encoding": "gzip, deflate, br" },
  }, (response) => {
    const status = response.statusCode ?? 0;
    const headers: Record<string, string> = {};
    const fail = (error: RetrievalError) => {
      clearTimeout(timer); reject(error); response.destroy(); request.destroy();
    };
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    // Redirect/error bodies are unnecessary; do not read arbitrary data from them.
    if (status < 200 || status >= 300) {
      clearTimeout(timer); response.destroy(); resolve({ status, headers, text: "" }); return;
    }
    const contentType = (headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!options.contentTypes.includes(contentType)) {
      fail(new RetrievalError("UNSUPPORTED_CONTENT_TYPE", "Unexpected source content type.")); return;
    }
    const length = Number(headers["content-length"]);
    if (Number.isFinite(length) && length > options.maxBytes) {
      fail(new RetrievalError("BODY_TOO_LARGE", "Response exceeds byte limit.")); return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) fail(new RetrievalError("BODY_TOO_LARGE", "Response exceeds byte limit."));
      else chunks.push(chunk);
    });
    response.on("error", (error) => { clearTimeout(timer); reject(error); });
    response.on("aborted", () => { clearTimeout(timer); reject(new RetrievalError("NETWORK_ERROR", "Source response was interrupted.")); });
    response.on("end", () => {
      clearTimeout(timer);
      try {
        const text = decodeBody(Buffer.concat(chunks), headers["content-encoding"] ?? "", options.maxDecodedBytes);
        if (Date.now() > options.deadline) throw new RetrievalError("TIMEOUT", "Fetch deadline exceeded.");
        resolve({ status, headers, text });
      } catch (error) { reject(error); }
    });
  });
  const timer = setTimeout(() => {
    const error = new RetrievalError("TIMEOUT", "Fetch deadline exceeded.");
    reject(error); request.destroy(error);
  }, remaining);
  request.on("error", (error) => { clearTimeout(timer); reject(error); });
  request.end();
});
