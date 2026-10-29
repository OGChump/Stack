import { NextRequest, NextResponse } from "next/server";

type AniListMediaType = "ANIME" | "MANGA";

type AniListMedia = {
  id: number;
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
};

type AniListGraphQLResponse = {
  data?: {
    Page?: {
      media?: AniListMedia[] | null;
    } | null;
  } | null;
  errors?: Array<{
    message?: string;
  }> | null;
};

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const q = (searchParams.get("q") ?? "").trim();
    const requestedType = (searchParams.get("type") ?? "ANIME").toUpperCase();
    const type: AniListMediaType =
      requestedType === "MANGA" ? "MANGA" : "ANIME";

    const requestedLimit = Number(searchParams.get("limit") ?? "7");
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(20, Math.trunc(requestedLimit)))
      : 7;

    if (!q) {
      return NextResponse.json(
        { error: "Missing search query.", results: [] },
        { status: 400 }
      );
    }

    const query = `
      query ($search: String, $perPage: Int, $type: MediaType) {
        Page(page: 1, perPage: $perPage) {
          media(search: $search, type: $type, sort: SEARCH_MATCH) {
            id
            title {
              romaji
              english
              native
            }
            coverImage {
              extraLarge
              large
              medium
            }
            genres
          }
        }
      }
    `;

    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          search: q,
          perPage: limit,
          type,
        },
      }),
      cache: "no-store",
    });

    const json: AniListGraphQLResponse = await response.json();

    if (!response.ok || json.errors?.length) {
      const message =
        json.errors?.find((entry) => entry?.message)?.message ||
        `AniList search failed (${response.status}).`;

      return NextResponse.json(
        { error: message, results: [] },
        { status: response.ok ? 502 : response.status }
      );
    }

    const media = Array.isArray(json.data?.Page?.media)
      ? json.data.Page.media
      : [];

    const results = media
      .filter((entry): entry is AniListMedia => Boolean(entry?.id))
      .map((entry) => {
        const title =
          entry.title?.english?.trim() ||
          entry.title?.romaji?.trim() ||
          entry.title?.native?.trim() ||
          "";

        const coverUrl =
          entry.coverImage?.extraLarge ||
          entry.coverImage?.large ||
          entry.coverImage?.medium ||
          undefined;

        return {
          id: entry.id,
          title,
          coverUrl,
          genres: Array.isArray(entry.genres) ? entry.genres : [],
        };
      })
      .filter((entry) => entry.title);

    return NextResponse.json({ results });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "AniList search failed.";

    return NextResponse.json(
      { error: message, results: [] },
      { status: 500 }
    );
  }
}
