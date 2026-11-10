import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type AniListMedia = {
  id: number;
  title?: { english?: string | null; romaji?: string | null; native?: string | null } | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null } | null;
  genres?: string[] | null;
};
type AniListSearchResponse = {
  data?: { Page?: { media?: AniListMedia[] | null } | null } | null;
  errors?: Array<{ message?: string }> | null;
};

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const q = String(params.get("q") || "").trim().slice(0, 120);
  const type = params.get("type") === "MANGA" ? "MANGA" : "ANIME";
  const requested = Number(params.get("limit") ?? 7);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(20, Math.trunc(requested))) : 7;
  if (!q) return NextResponse.json({ error: "Missing search query", results: [] }, { status: 400 });

  const query = `query ($search: String, $perPage: Int, $type: MediaType) {
    Page(page: 1, perPage: $perPage) {
      media(search: $search, type: $type, sort: SEARCH_MATCH) {
        id title { romaji english native } coverImage { extraLarge large medium } genres
      }
    }
  }`;
  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { search: q, perPage: limit, type } }),
      cache: "no-store",
    });
    const raw = (await response.json().catch(() => ({}))) as AniListSearchResponse;
    if (!response.ok || raw.errors?.length) {
      const status = response.status === 429 ? 429 : 502;
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      if (status === 429) headers["Retry-After"] = response.headers.get("retry-after") || "10";
      return NextResponse.json({ error: raw.errors?.[0]?.message || `AniList search failed (${response.status})`, results: [] }, { status, headers });
    }
    const rows = Array.isArray(raw.data?.Page?.media) ? raw.data!.Page!.media! : [];
    const results = rows.filter((row) => row?.id).map((row) => ({
      id: row.id,
      title: row.title?.english || row.title?.romaji || row.title?.native || "",
      coverUrl: row.coverImage?.extraLarge || row.coverImage?.large || row.coverImage?.medium || undefined,
      genres: Array.isArray(row.genres) ? row.genres : [],
    })).filter((row) => row.title);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("AniList search failed", error);
    return NextResponse.json({ error: "AniList search failed.", results: [] }, { status: 502 });
  }
}
