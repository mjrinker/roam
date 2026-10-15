/** Small helpers shared by the /api/v1 routes (JSON in, JSON out, one error shape, never cached). */
import { NextResponse } from "next/server";
import { z } from "zod";

export const apiJson = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export const apiError = (status: number, error: string, code?: string) => apiJson({ error, ...(code ? { code } : {}) }, status);
export const apiNotFound = () => apiError(404, "Not found", "not_found");
export const apiUnauthorized = () => apiError(401, "Sign in required", "unauthorized");

/** A JSON body checked against a schema; an error response when it is missing or wrong. */
export async function readBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T> | NextResponse> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  return parsed.success ? parsed.data : apiError(400, "Invalid request", "invalid_request");
}

export const uuidSchema = z.string().uuid();
export const asId = (v: string): string | null => (uuidSchema.safeParse(v).success ? v : null);
