// Request bodies and stored values are untrusted: look before using them.
export type Json = Record<string, unknown>;

export const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** A request's JSON body as an object (empty if it isn't one). */
export async function jsonBody(req: Request): Promise<Json> {
  const v: unknown = await req.json().catch(() => null);
  return isRecord(v) ? v : {};
}
