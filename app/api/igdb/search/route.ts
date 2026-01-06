import { NextResponse } from "next/server";

type IgdbCover = { url?: string };
type IgdbGenre = { name?: string };

type IgdbGame = {
  id: number;
  name: string;
  cover?: IgdbCover;
  genres?: IgdbGenre[];
};

let cachedToken: string | null = null;
let cachedTokenExpMs = 0;

async function getTwitchToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpMs - 60_000) return cachedToken; // refresh 60s early

  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing IGDB env vars: IGDB_CLIENT_ID / IGDB_CLIENT_SECRET");
  }

  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) throw new Error(`Twitch token failed (${res.status})`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = json.access_token;
  cachedTokenExpMs = Date.now() + json.expires_in * 1000;

  return cachedToken;
}

function normalizeIgdbCoverUrl(url?: string) {
  // IGDB returns URLs like: //images.igdb.com/igdb/image/upload/t_thumb/...
  if (!url) return "";
  const withProto = url.startsWith("//") ? `https:${url}` : url;
  // Better size for your UI: t_cover_big is a solid default
  return withProto.replace("/t_thumb/", "/t_cover_big/");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const limit = Math.max(1, Math.min(10, Number(searchParams.get("limit") || "5")));

    if (q.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const token = await getTwitchToken();
    const clientId = process.env.IGDB_CLIENT_ID!;

    // IGDB API uses POST with an "Apicalypse" query string body
    const body = `
      search "${q.replaceAll('"', '\\"')}";
      fields id,name,cover.url,genres.name;
      limit ${limit};
      where version_parent = null;
    `;

    const igdbRes = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body,
      // Next.js: don’t cache user-specific searches
      cache: "no-store",
    });

    if (!igdbRes.ok) {
      const text = await igdbRes.text().catch(() => "");
      throw new Error(`IGDB search failed (${igdbRes.status}) ${text}`);
    }

    const data = (await igdbRes.json()) as IgdbGame[];

    const results = (data || []).map((g) => ({
      id: g.id,
      name: g.name,
      coverUrl: normalizeIgdbCoverUrl(g.cover?.url),
      genres: (g.genres || []).map((x) => x.name).filter(Boolean) as string[],
    }));

    return NextResponse.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg, results: [] }, { status: 500 });
  }
}
