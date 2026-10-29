import { NextRequest, NextResponse } from "next/server";

type AniListType = "ANIME" | "MANGA";

type LookupRequestEntry = {
  key: string;
  malId: number;
  type: AniListType;
};

type AniListMedia = {
  id?: number | null;
  title?: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
  } | null;
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
    medium?: string | null;
  } | null;
  genres?: string[] | null;
  episodes?: number | null;
  duration?: number | null;
  chapters?: number | null;
  volumes?: number | null;
};

type AniListBatchResponse = {
  data?: Record<string, AniListMedia | null> | null;
  errors?: Array<{ message?: string; status?: number }> | null;
};

type LookupResult = {
  id: number;
  title: string;
  coverUrl?: string;
  genres?: string[];
  episodes?: number | null;
  duration?: number | null;
  chapters?: number | null;
  volumes?: number | null;
};

export const dynamic = "force-dynamic";

const MAX_BATCH_SIZE = 400;
const GRAPHQL_CHUNK_SIZE = 20;

function normalizeType(value: unknown): AniListType {
  return String(value || "").toUpperCase() === "MANGA" ? "MANGA" : "ANIME";
}

function normalizeEntry(value: unknown, index: number): LookupRequestEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const malId = Number(row.malId);
  if (!Number.isFinite(malId) || malId <= 0) return null;
  const rawKey = typeof row.key === "string" ? row.key.trim() : "";
  return {
    key: rawKey || `entry-${index}`,
    malId: Math.trunc(malId),
    type: normalizeType(row.type),
  };
}

function mediaToResult(media: AniListMedia | null | undefined): LookupResult | null {
  if (!media?.id) return null;
  const title = String(
    media.title?.english || media.title?.romaji || media.title?.native || ""
  ).trim();
  const coverUrl =
    media.coverImage?.extraLarge ||
    media.coverImage?.large ||
    media.coverImage?.medium ||
    undefined;

  return {
    id: Number(media.id),
    title,
    coverUrl,
    genres: Array.isArray(media.genres)
      ? media.genres.map((value) => String(value))
      : undefined,
    episodes: typeof media.episodes === "number" ? media.episodes : null,
    duration: typeof media.duration === "number" ? media.duration : null,
    chapters: typeof media.chapters === "number" ? media.chapters : null,
    volumes: typeof media.volumes === "number" ? media.volumes : null,
  };
}

async function fetchChunk(entries: LookupRequestEntry[]) {
  const selections = entries
    .map(
      (entry, index) => `
        m${index}: Media(idMal: ${entry.malId}, type: ${entry.type}) {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
          genres
          episodes
          duration
          chapters
          volumes
        }
      `
    )
    .join("\n");

  const query = `query StackMalArtworkBatch { ${selections} }`;
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });

  const json: AniListBatchResponse = await response.json().catch(() => ({}));

  if (!response.ok && !json.data) {
    const retryAfter = response.headers.get("retry-after");
    const suffix = retryAfter ? ` Retry after ${retryAfter}s.` : "";
    throw new Error(`AniList MAL lookup failed (${response.status}).${suffix}`);
  }

  const data = json.data ?? {};
  return entries.map((entry, index) => ({
    key: entry.key,
    malId: entry.malId,
    type: entry.type,
    result: mediaToResult(data[`m${index}`]),
  }));
}

async function lookupEntries(entries: LookupRequestEntry[]) {
  const output: Array<{
    key: string;
    malId: number;
    type: AniListType;
    result: LookupResult | null;
  }> = [];

  for (let start = 0; start < entries.length; start += GRAPHQL_CHUNK_SIZE) {
    const chunk = entries.slice(start, start + GRAPHQL_CHUNK_SIZE);
    const rows = await fetchChunk(chunk);
    output.push(...rows);

    // A tiny pause between GraphQL batches avoids burst-limiter spikes while still
    // reducing a 100-entry MAL import to only five AniList requests.
    if (start + GRAPHQL_CHUNK_SIZE < entries.length) {
      await new Promise((resolve) => setTimeout(resolve, 175));
    }
  }

  return output;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const entry = normalizeEntry(
    {
      key: "single",
      malId: searchParams.get("malId"),
      type: searchParams.get("type"),
    },
    0
  );

  if (!entry) {
    return NextResponse.json(
      { error: "A valid MAL ID is required." },
      { status: 400 }
    );
  }

  try {
    const [row] = await lookupEntries([entry]);
    return NextResponse.json({ result: row?.result ?? null });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "AniList lookup failed.";
    console.error("AniList MAL-ID lookup failed", error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    const rawEntries =
      body && typeof body === "object" && Array.isArray((body as { entries?: unknown }).entries)
        ? (body as { entries: unknown[] }).entries
        : [];

    const entries = rawEntries
      .slice(0, MAX_BATCH_SIZE)
      .map((value, index) => normalizeEntry(value, index))
      .filter((value): value is LookupRequestEntry => Boolean(value));

    if (!entries.length) {
      return NextResponse.json(
        { error: "At least one valid MAL lookup entry is required.", results: [] },
        { status: 400 }
      );
    }

    const results = await lookupEntries(entries);
    return NextResponse.json({ results });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "AniList batch lookup failed.";
    console.error("AniList MAL-ID batch lookup failed", error);
    return NextResponse.json({ error: message, results: [] }, { status: 502 });
  }
}
