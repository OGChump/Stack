import { NextResponse } from "next/server";

type AniTitle = { romaji?: string; english?: string; native?: string };
type AniCover = { extraLarge?: string; large?: string; medium?: string };
type AniGenre = string;

type AniMedia = {
  id: number;
  title?: AniTitle;
  coverImage?: AniCover;
  genres?: AniGenre[];
};

type AniListResponse = {
  data?: {
    Page?: {
      media?: AniMedia[];
    };
  };
  errors?: Array<{ message: string }>;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const limit = Math.max(1, Math.min(10, Number(searchParams.get("limit") || "5")));
    const typeParam = (searchParams.get("type") || "ANIME").toUpperCase();

    const mediaType = typeParam === "MANGA" ? "MANGA" : "ANIME";

    if (q.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const query = `
      query ($search: String, $perPage: Int, $type: MediaType) {
        Page(perPage: $perPage) {
          media(search: $search, type: $type, sort: POPULARITY_DESC) {
            id
            title { romaji english native }
            coverImage { extraLarge large medium }
            genres
          }
        }
      }
    `;

    const body = JSON.stringify({
      query,
      variables: { search: q, perPage: limit, type: mediaType },
    });

    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      cache: "no-store",
    });

    const json = (await res.json()) as AniListResponse;

    if (!res.ok || json.errors?.length) {
      const msg =
        json.errors?.map((e) => e.message).join(" | ") ||
        `AniList search failed (${res.status})`;
      return NextResponse.json({ error: msg, results: [] }, { status: 500 });
    }

    const media = json.data?.Page?.media ?? [];

    const results = media.map((m) => {
      const title =
        m.title?.english?.trim() ||
        m.title?.romaji?.trim() ||
        m.title?.native?.trim() ||
        "Untitled";

      const coverUrl =
        m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || "";

      return {
        id: m.id,
        title,
        coverUrl: coverUrl || undefined,
        genres: (m.genres ?? []).filter(Boolean),
      };
    });

    return NextResponse.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg, results: [] }, { status: 500 });
  }
}
