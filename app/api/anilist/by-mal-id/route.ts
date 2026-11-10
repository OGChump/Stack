import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type MediaType = "ANIME" | "MANGA";
type Entry = { key: string; malId: number; type: MediaType };
type AniListMedia = {
  id?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null } | null;
  genres?: string[] | null;
  episodes?: number | null;
  duration?: number | null;
  chapters?: number | null;
  volumes?: number | null;
};
type GqlResponse = {
  data?: Record<string, AniListMedia | null>;
  errors?: Array<{ message?: string; status?: number }>;
};
const MAX_PER_REQUEST = 40;
const UPSTREAM_BATCH = 20;
const UPSTREAM_PAUSE_MS = 1300;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseEntry(value: unknown, index: number): Entry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const malId = Number(row.malId);
  if (!Number.isSafeInteger(malId) || malId <= 0) return null;
  return {
    key: typeof row.key === "string" && row.key.trim() ? row.key.slice(0, 160) : `entry-${index}`,
    malId,
    type: row.type === "MANGA" ? "MANGA" : "ANIME",
  };
}

function normalize(media?: AniListMedia | null) {
  if (!media?.id) return null;
  return {
    id: media.id,
    title: media.title?.english || media.title?.romaji || media.title?.native || "",
    coverUrl: media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || undefined,
    genres: Array.isArray(media.genres) ? media.genres : [],
    episodes: media.episodes ?? null,
    duration: media.duration ?? null,
    chapters: media.chapters ?? null,
    volumes: media.volumes ?? null,
  };
}

async function fetchUpstream(entries: Entry[]): Promise<Array<Entry & { result: ReturnType<typeof normalize> }>> {
  const selections = entries.map((entry, index) => `m${index}: Media(idMal: ${entry.malId}, type: ${entry.type}) {
    id title { english romaji native } coverImage { extraLarge large medium }
    genres episodes duration chapters volumes
  }`).join("\n");
  const query = `query StackByMalId { ${selections} }`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    const raw = (await response.json().catch(() => ({}))) as GqlResponse;
    const rateLimited = response.status === 429 || raw.errors?.some((e) => e.status === 429);
    if (rateLimited && attempt < MAX_RETRIES) {
      const seconds = Number(response.headers.get("retry-after") || "0");
      await sleep(Math.max(2000 * (attempt + 1), Number.isFinite(seconds) ? seconds * 1000 : 0));
      continue;
    }
    if (!response.ok || raw.errors?.length) {
      const reason = raw.errors?.find((e) => e.message)?.message || `AniList failed (${response.status})`;
      const error = new Error(reason) as Error & { status?: number; retryAfter?: string };
      error.status = rateLimited ? 429 : 502;
      if (rateLimited) error.retryAfter = response.headers.get("retry-after") || "10";
      throw error;
    }
    const data = raw.data ?? {};
    return entries.map((entry, index) => ({ ...entry, result: normalize(data[`m${index}`]) }));
  }
  throw new Error("AniList rate limit continued beyond retry budget.");
}

async function lookup(entries: Entry[]) {
  const results: Array<Entry & { result: ReturnType<typeof normalize> }> = [];
  for (let start = 0; start < entries.length; start += UPSTREAM_BATCH) {
    if (start) await sleep(UPSTREAM_PAUSE_MS);
    results.push(...(await fetchUpstream(entries.slice(start, start + UPSTREAM_BATCH))));
  }
  return results;
}

function failure(error: unknown) {
  console.error("AniList MAL lookup failed", error);
  const err = error as Error & { status?: number; retryAfter?: string };
  const status = err.status === 429 ? 429 : 502;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (status === 429) headers["Retry-After"] = err.retryAfter || "10";
  return NextResponse.json({ error: err.message || "AniList lookup failed." }, { status, headers });
}

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const entry = parseEntry({ key: "single", malId: params.get("malId"), type: params.get("type") }, 0);
  if (!entry) return NextResponse.json({ error: "A valid MAL ID is required." }, { status: 400 });
  try {
    const rows = await lookup([entry]);
    return NextResponse.json({ result: rows[0]?.result ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const raw = body && typeof body === "object" && "entries" in body ? (body as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PER_REQUEST) {
    return NextResponse.json({ error: `Send 1–${MAX_PER_REQUEST} MAL entries per request.` }, { status: 400 });
  }
  const entries = raw.map(parseEntry);
  if (entries.some((e) => e === null)) return NextResponse.json({ error: "One or more MAL IDs were invalid." }, { status: 400 });
  try {
    return NextResponse.json({ results: await lookup(entries as Entry[]) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
