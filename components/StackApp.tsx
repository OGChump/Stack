"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabaseClient";
import { DndContext, DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";

/* ================= TYPES ================= */

type MediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
type Status = "planned" | "in_progress" | "dropped" | "completed";

type GroupMode = "none" | "day" | "month" | "year";
type SortMode = "newest" | "oldest" | "title" | "rating_high" | "rating_low";

export type StackView = "all" | "completed" | "watching" | "watchlist" | "dropped" | "stats" | "add";

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;

  rating?: number; // 0-10
  posterUrl?: string; // autofill/base
  posterOverrideUrl?: string; // user override (keeps db info intact)

  // TMDB fields (movie/tv only)
  tmdbId?: number;
  tmdbType?: "movie" | "tv";

  // IGDB fields (game only)
  igdbId?: number;

  // AniList fields (anime/manga)
  anilistId?: number;
  anilistType?: "ANIME" | "MANGA";

  inTheaters?: boolean;
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;
  rewatchCount?: number;
  runtime?: number; // minutes (movie=full runtime; tv/anime=per-episode approx)
  status: Status;
  tags: string[];
  createdAt: string; // ISO

  // Optional progress
  progressCur?: number;
  progressTotal?: number;

  // optional manual override
  progressCurOverride?: number;
  progressTotalOverride?: number;

  // games
  hoursPlayed?: number; // manual hours played
};

type TmdbSearchResult = {
  results?: Array<{ id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }>;
};

type TmdbGenre = { name: string };

type TmdbDetailsResult = {
  poster_path?: string | null;
  runtime?: number | null;
  episode_run_time?: number[] | null;
  genres?: TmdbGenre[] | null;
  number_of_episodes?: number | null;
};

type TmdbRecommendationsResult = {
  results?: Array<{ id: number; title?: string; name?: string }>;
};

type IgdbSearchResponse = {
  results: Array<{ id: number; name: string; coverUrl?: string; genres?: string[] }>;
  error?: string;
};

type AnilistSearchResponse = {
  results: Array<{ id: number; title: string; coverUrl?: string; genres?: string[] }>;
  error?: string;
};

type Pick = { title: string; posterUrl?: string; tmdbId?: number; tmdbType?: "movie" | "tv" };

type Suggestion = {
  key: string; // unique key for list rendering
  provider: "tmdb" | "igdb" | "anilist";
  title: string;
  subtitle?: string;
  posterUrl?: string;
  tags?: string[];
  runtime?: number;
  progressTotal?: number;
  // ids
  tmdbId?: number;
  tmdbType?: "movie" | "tv";
  igdbId?: number;
  anilistId?: number;
  anilistType?: "ANIME" | "MANGA";
};

const LOCAL_BACKUP_KEY = "stack-items-backup-v1";

const TYPE_LABEL: Record<MediaType, string> = {
  movie: "Movie",
  tv: "TV",
  anime: "Anime",
  manga: "Manga",
  book: "Book",
  game: "Game",
};

const STATUSES: Array<{ id: Status; label: string }> = [
  { id: "completed", label: "Completed" },
  { id: "in_progress", label: "In Progress" },
  { id: "planned", label: "Planned" },
  { id: "dropped", label: "Dropped" },
];

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function toGroupKey(mode: GroupMode, dateStr?: string) {
  if (!dateStr) return "Undated";
  if (mode === "day") return dateStr.slice(0, 10);
  if (mode === "month") return dateStr.slice(0, 7);
  if (mode === "year") return dateStr.slice(0, 4);
  return "All";
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function uniqTags(tags: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = String(t || "").trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function normTitle(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Levenshtein distance */
function levenshtein(a: string, b: string) {
  const s = a;
  const t = b;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n];
}

/** Similarity score 0..1 (1 = identical) */
function similarityScore(aRaw: string, bRaw: string) {
  const a = normTitle(aRaw);
  const b = normTitle(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // prefix boost for tab-to-complete
  if (b.startsWith(a)) {
    const prefixBoost = 0.15 * Math.min(1, a.length / Math.max(1, b.length));
    return Math.min(1, 0.85 + prefixBoost);
  }

  const dist = levenshtein(a, b);
  const denom = Math.max(a.length, b.length);
  return denom ? 1 - dist / denom : 0;
}

function getMovieProgressDefaults(item: MediaItem) {
  const total = typeof item.progressTotalOverride === "number" ? item.progressTotalOverride : item.progressTotal;
  const cur = typeof item.progressCurOverride === "number" ? item.progressCurOverride : item.progressCur;

  if (item.type !== "movie") return { cur, total };

  const finalTotal = typeof total === "number" ? total : 1;
  const finalCur = typeof cur === "number" ? cur : item.status === "completed" ? 1 : 0;

  return { cur: finalCur, total: finalTotal };
}

/* ================= TMDB ================= */

async function tmdbSearch(title: string, type: "movie" | "tv"): Promise<TmdbSearchResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", title);
  url.searchParams.set("include_adult", "false");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB search failed (${res.status}).`);
  return (await res.json()) as TmdbSearchResult;
}

async function tmdbDetails(id: number, type: "movie" | "tv"): Promise<TmdbDetailsResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/${type}/${id}`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB details failed (${res.status}).`);
  return (await res.json()) as TmdbDetailsResult;
}

async function tmdbRecommendations(id: number, type: "movie" | "tv"): Promise<TmdbRecommendationsResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/${type}/${id}/recommendations`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB recommendations failed (${res.status}).`);
  return (await res.json()) as TmdbRecommendationsResult;
}

/* ================= ANILIST GRAPHQL (for progress totals) ================= */

async function anilistDetails(
  id: number,
  type: "ANIME" | "MANGA"
): Promise<{
  coverUrl?: string;
  genres?: string[];
  episodes?: number | null;
  chapters?: number | null;
  volumes?: number | null;
}> {
  const query = `
    query ($id: Int, $type: MediaType) {
      Media(id: $id, type: $type) {
        coverImage { extraLarge large medium }
        genres
        episodes
        chapters
        volumes
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id, type } }),
  });

  if (!res.ok) throw new Error(`AniList details failed (${res.status}).`);
  type AniListDetailsResponse = {
    data?: {
      Media?: {
        coverImage?: { extraLarge?: string; large?: string; medium?: string };
        genres?: string[];
        episodes?: number | null;
        chapters?: number | null;
        volumes?: number | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const json: AniListDetailsResponse = await res.json();
  const m = json?.data?.Media;
  const coverUrl = m?.coverImage?.extraLarge || m?.coverImage?.large || m?.coverImage?.medium || undefined;
  const genres = Array.isArray(m?.genres) ? (m.genres as string[]) : undefined;

  return {
    coverUrl,
    genres,
    episodes: typeof m?.episodes === "number" ? m.episodes : null,
    chapters: typeof m?.chapters === "number" ? m.chapters : null,
    volumes: typeof m?.volumes === "number" ? m.volumes : null,
  };
}

// ================= RECOMMENDER HELPERS (TMDB) =================

type TmdbTrendingResult = {
  results?: Array<{ id: number; title?: string; name?: string }>;
};

function normTag(s: string) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function computeTasteProfile(items: MediaItem[]) {
  // Use completed items, prioritize highly-rated ones
  const completed = items.filter((i) => i.status === "completed");
  const rated = completed
    .filter((i) => typeof i.rating === "number")
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

  const seeds = rated.slice(0, 12);

  // Top tags (genres) weighted by rating
  const tagScore = new Map<string, number>();
  for (const i of seeds) {
    const w = (i.rating ?? 0) / 10; // 0..1
    for (const t of i.tags ?? []) {
      const k = normTag(t);
      if (!k) continue;
      tagScore.set(k, (tagScore.get(k) ?? 0) + w);
    }
  }

  const topTags = Array.from(tagScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k]) => k);

  // Type preference from last ~30 items (what you’ve been consuming)
  const recent = items.slice(0, 30);
  const typeCounts = new Map<MediaType, number>();
  for (const i of recent) typeCounts.set(i.type, (typeCounts.get(i.type) ?? 0) + 1);
  const total = Math.max(1, recent.length);

  const typePref: Record<MediaType, number> = {
    movie: (typeCounts.get("movie") ?? 0) / total,
    tv: (typeCounts.get("tv") ?? 0) / total,
    anime: (typeCounts.get("anime") ?? 0) / total,
    manga: (typeCounts.get("manga") ?? 0) / total,
    book: (typeCounts.get("book") ?? 0) / total,
    game: (typeCounts.get("game") ?? 0) / total,
  };

  return { topTags, typePref };
}

async function tmdbTrending(mediaType: "movie" | "tv"): Promise<TmdbTrendingResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/trending/${mediaType}/week`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB trending failed (${res.status}).`);
  return (await res.json()) as TmdbTrendingResult;
}

function scoreCandidate(opts: { candidateTags: string[]; userTopTags: string[]; typeBoost: number }) {
  const cand = uniq(opts.candidateTags.map(normTag)).filter(Boolean);
  const user = uniq(opts.userTopTags.map(normTag)).filter(Boolean);

  if (!cand.length || !user.length) {
    return 0.15 + 0.35 * clamp01(opts.typeBoost);
  }

  const candSet = new Set(cand);
  let overlap = 0;
  for (const t of user) if (candSet.has(t)) overlap += 1;

  const overlapScore = overlap / Math.max(1, Math.min(user.length, 8));
  return 0.65 * clamp01(overlapScore) + 0.35 * clamp01(opts.typeBoost);
}

function diversifyPicks(picks: Array<Pick & { score: number; tags: string[] }>, maxPerTopTag = 2) {
  const out: Array<Pick & { score: number; tags: string[] }> = [];
  const tagCounts = new Map<string, number>();

  for (const p of picks) {
    const primary = normTag(p.tags?.[0] ?? "");
    if (primary) {
      const c = tagCounts.get(primary) ?? 0;
      if (c >= maxPerTopTag) continue;
      tagCounts.set(primary, c + 1);
    }
    out.push(p);
    if (out.length >= 8) break;
  }

  return out.length ? out : picks.slice(0, 8);
}

/* ================= APP ================= */

export default function StackApp({ view = "all" }: { view?: StackView }) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [groupMode] = useState<GroupMode>("none");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [boardView, setBoardView] = useState(true);

  const [autofillStatus, setAutofillStatus] = useState("");
  const [autoAutofill, setAutoAutofill] = useState(true);
  const autofillTimer = useRef<number | null>(null);
  const lastAutofillKey = useRef<string>("");

  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  const [picks, setPicks] = useState<Pick[]>([]);
  const [pickStatus, setPickStatus] = useState("");

  const [excludeTypes, setExcludeTypes] = useState<Set<MediaType>>(new Set());

  // Autofill UX improvements
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [ghostTitle, setGhostTitle] = useState<string>("");
  const [activeSuggestIdx, setActiveSuggestIdx] = useState(0);

  // For "delete 0 and type" UX
  const [ratingText, setRatingText] = useState<string>(""); // decimal ok
  const [rewatchText, setRewatchText] = useState<string>("0"); // integer
  const [progressCurText, setProgressCurText] = useState<string>(""); // integer
  const [progressTotalText, setProgressTotalText] = useState<string>(""); // integer

  // Manual tags editor (keeps autofilled tags but allows extras)
  const [autoTags, setAutoTags] = useState<string[]>([]);
  const [manualTags, setManualTags] = useState<string[]>([]);

  // ✅ Undo delete
  const [undoState, setUndoState] = useState<{ item: MediaItem; index: number } | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Add form lives only on /add
  const [form, setForm] = useState<Partial<MediaItem>>({
    title: "",
    type: "movie",
    status: "completed",
    tags: [],
    inTheaters: false,
    notes: "",
    dateFinished: "",
    rewatchCount: 0,
    rating: undefined,

    posterUrl: "",
    posterOverrideUrl: "",

    tmdbId: undefined,
    tmdbType: undefined,
    igdbId: undefined,
    anilistId: undefined,
    anilistType: undefined,

    progressCur: undefined,
    progressTotal: undefined,
  });

  // ✅ keep latest form in a ref (prevents stale status/type inside applySuggestion)
  const formRef = useRef<Partial<MediaItem>>(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const isRewatch = (Number(rewatchText || "0") || 0) > 0;

  /* ================= NAV ================= */

  const navMain = useMemo(
    () => [
      { href: "/", label: "All", key: "all" as StackView },
      { href: "/completed", label: "Completed", key: "completed" as StackView },
      { href: "/watching", label: "In Progress", key: "watching" as StackView },
      { href: "/watchlist", label: "Planned", key: "watchlist" as StackView },
      { href: "/dropped", label: "Dropped", key: "dropped" as StackView },
    ],
    []
  );

  const navActions = useMemo(
    () => [
      { href: "/stats", label: "Stats", key: "stats" as StackView, icon: "pie" as const },
      { href: "/add", label: "Add", key: "add" as StackView, icon: "plus" as const },
    ],
    []
  );

  /* ================= LOCAL BACKUP ================= */

  const loadLocalBackup = useCallback((): MediaItem[] | null => {
    try {
      const raw = localStorage.getItem(LOCAL_BACKUP_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as MediaItem[]) : null;
    } catch {
      return null;
    }
  }, []);

  const saveLocalBackup = useCallback((next: MediaItem[]) => {
    try {
      localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  /* ================= SUPABASE ================= */

  const loadCloud = useCallback(
    async (uidStr: string) => {
      setSaveStatus("Loading…");
      setCloudLoaded(false);

      const { data, error } = await supabase.from("media_items").select("data").eq("user_id", uidStr).maybeSingle();

      if (error) {
        console.error(error);
        const backup = loadLocalBackup();
        if (backup) setItems(backup);
        setCloudLoaded(true);
        setSaveStatus("Loaded (local backup)");
        return;
      }

      if (data?.data && typeof data.data === "object" && "items" in data.data) {
        const next = (data.data as { items: MediaItem[] }).items ?? [];
        setItems(next);
        saveLocalBackup(next);
        setCloudLoaded(true);
        setSaveStatus("Loaded");
      } else {
        const ins = await supabase.from("media_items").insert({
          user_id: uidStr,
          data: { items: [] },
        });

        if (ins.error) {
          console.error(ins.error);
          const backup = loadLocalBackup();
          if (backup) setItems(backup);
          setCloudLoaded(true);
          setSaveStatus("Loaded (local backup)");
          return;
        }

        setItems([]);
        saveLocalBackup([]);
        setCloudLoaded(true);
        setSaveStatus("Loaded");
      }
    },
    [loadLocalBackup, saveLocalBackup]
  );

  const saveCloud = useCallback(
    async (uidStr: string, next: MediaItem[]) => {
      saveLocalBackup(next);
      if (!cloudLoaded) return;

      setSaveStatus("Saving…");

      const { error } = await supabase
        .from("media_items")
        .upsert({ user_id: uidStr, data: { items: next } }, { onConflict: "user_id" });

      if (error) {
        console.error(error);
        setSaveStatus("Saved locally (cloud error)");
        return;
      }

      setSaveStatus("Saved");
    },
    [cloudLoaded, saveLocalBackup]
  );

  useEffect(() => {
    const backup = loadLocalBackup();
    if (backup) setItems(backup);
  }, [loadLocalBackup]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const id = data.user?.id ?? null;
      setUserId(id);
      if (id) loadCloud(id);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      const id = s?.user?.id ?? null;
      setUserId(id);
      if (id) loadCloud(id);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadCloud]);

  useEffect(() => {
    if (userId) saveCloud(userId, items);
    else saveLocalBackup(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, userId, cloudLoaded]);

  /* ================= ACTIONS ================= */

  function addItem(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!form.title) return;

    const status = (form.status as Status) ?? "completed";

    const manualDate = (form.dateFinished || "").trim();
    const autoDate = status === "completed" ? todayYMD() : "";
    const finalDate = manualDate || autoDate || undefined;

    const ratingNum = ratingText.trim() === "" ? undefined : Number(ratingText);
    const rating = typeof ratingNum === "number" && Number.isFinite(ratingNum) ? clamp(ratingNum, 0, 10) : undefined;

    const rewatchCount = rewatchText.trim() === "" ? 0 : Math.max(0, Number(rewatchText) || 0);

    const pc = progressCurText.trim() === "" ? undefined : Math.max(0, Number(progressCurText) || 0);
    const pt = progressTotalText.trim() === "" ? undefined : Math.max(0, Number(progressTotalText) || 0);

    // Progress defaults:
    const inferredTotal = (form.type as MediaType) === "movie" ? (typeof pt === "number" ? pt : 1) : pt;
    const inferredCur =
      typeof pc === "number"
        ? pc
        : status === "completed" && typeof inferredTotal === "number"
        ? inferredTotal
        : undefined;

    const tags = uniqTags([...(autoTags ?? []), ...(manualTags ?? [])]);

    const item: MediaItem = {
      id: uid(),
      title: String(form.title).trim(),
      type: form.type as MediaType,
      status,
      inTheaters: !!form.inTheaters,
      dateFinished: finalDate,

      posterUrl: (form.posterUrl || "").trim() || undefined,
      posterOverrideUrl: (form.posterOverrideUrl || "").trim() || undefined,

      runtime: typeof form.runtime === "number" ? form.runtime : undefined,
      notes: (form.notes || "").trim() || undefined,
      tags,
      rewatchCount,
      createdAt: new Date().toISOString(),
      rating,

      tmdbId: typeof form.tmdbId === "number" ? form.tmdbId : undefined,
      tmdbType: form.tmdbType === "movie" || form.tmdbType === "tv" ? form.tmdbType : undefined,
      igdbId: typeof form.igdbId === "number" ? form.igdbId : undefined,
      anilistId: typeof form.anilistId === "number" ? form.anilistId : undefined,
      anilistType: form.anilistType === "ANIME" || form.anilistType === "MANGA" ? form.anilistType : undefined,

      progressCur: typeof inferredCur === "number" ? inferredCur : undefined,
      progressTotal: typeof inferredTotal === "number" ? inferredTotal : undefined,

      hoursPlayed: typeof form.hoursPlayed === "number" ? form.hoursPlayed : undefined,
    };

    setItems((p) => [item, ...p]);

    // reset
    setAutofillStatus("");
    setSuggestions([]);
    setShowSuggest(false);
    setGhostTitle("");
    setActiveSuggestIdx(0);

    setForm((prev) => ({
      title: "",
      type: prev.type ?? "movie",
      status: "completed",
      tags: [],
      inTheaters: false,
      notes: "",
      dateFinished: "",
      posterUrl: "",
      posterOverrideUrl: "",
      runtime: undefined,
      rewatchCount: 0,
      rating: undefined,
      tmdbId: undefined,
      tmdbType: undefined,
      igdbId: undefined,
      anilistId: undefined,
      anilistType: undefined,
      progressCur: undefined,
      progressTotal: undefined,
      hoursPlayed: undefined,
    }));

    setAutoTags([]);
    setManualTags([]);

    setRatingText("");
    setRewatchText("0");
    setProgressCurText("");
    setProgressTotalText("");
  }

  // ✅ Undo delete
  function removeItem(id: string) {
    setItems((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx === -1) return prev;

      const deleted = prev[idx];

      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);

      setUndoState({ item: deleted, index: idx });

      undoTimerRef.current = window.setTimeout(() => {
        setUndoState(null);
        undoTimerRef.current = null;
      }, 7000);

      return prev.filter((x) => x.id !== id);
    });
  }

  // ✅ Smart status + smart date + progress auto-complete
  function updateItem(id: string, patch: Partial<MediaItem>) {
    setItems((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;

        const merged: MediaItem = { ...x, ...patch };

        const hadCompleted = x.status === "completed";
        const nowCompleted = merged.status === "completed";

        // ✅ Was status explicitly changed by the user in this update?
        const statusExplicit = Object.prototype.hasOwnProperty.call(patch, "status");

        const getEffectiveProgress = (it: MediaItem) => {
          if (it.type === "movie") {
            const d = getMovieProgressDefaults(it);
            return { cur: d.cur, total: d.total };
          }

          const cur = typeof it.progressCurOverride === "number" ? it.progressCurOverride : it.progressCur;
          const total = typeof it.progressTotalOverride === "number" ? it.progressTotalOverride : it.progressTotal;
          return { cur, total };
        };

        // If status becomes completed and no date, set to today
        if (!hadCompleted && nowCompleted && !merged.dateFinished) {
          merged.dateFinished = todayYMD();
        }

        const { cur, total } = getEffectiveProgress(merged);
        const totalNum = typeof total === "number" && Number.isFinite(total) ? total : undefined;
        const curNum = typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;

        // ✅ Only auto-complete from progress when status was NOT manually changed
        if (
          !statusExplicit &&
          merged.status !== "completed" &&
          typeof totalNum === "number" &&
          totalNum > 0 &&
          typeof curNum === "number" &&
          curNum >= totalNum
        ) {
          merged.status = "completed";
          if (!merged.dateFinished) merged.dateFinished = todayYMD();
        }

        // When completed, make progress "finished" where appropriate
        if (merged.status === "completed") {
          if (merged.type === "movie") {
            merged.progressTotal = 1;
            merged.progressCur = 1;
          } else if (merged.type === "tv" || merged.type === "anime" || merged.type === "manga") {
            if (typeof totalNum === "number" && totalNum > 0) {
              const currentCur =
                typeof merged.progressCurOverride === "number" ? merged.progressCurOverride : merged.progressCur;

              if (typeof currentCur !== "number" || currentCur < totalNum) {
                merged.progressCur = totalNum;
              }
            }
          }
        }

        return merged;
      })
    );
  }

  async function pickForMe(mode: "best" | "random" = "best") {
    try {
      setPickStatus(mode === "random" ? "Finding something random…" : "Finding picks…");
      setPicks([]);

      const existingTitles = new Set(items.map((i) => i.title.toLowerCase()));
      const taste = computeTasteProfile(items);

      const seed = items
        .filter((i) => i.tmdbId && (i.tmdbType === "movie" || i.tmdbType === "tv") && typeof i.rating === "number")
        .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
        .slice(0, 10);

      const fallbackSeed = items
        .filter((i) => i.tmdbId && (i.tmdbType === "movie" || i.tmdbType === "tv"))
        .slice(0, 8);

      const seeds = seed.length ? seed : fallbackSeed;

      const pool: Array<{ title: string; tmdbId: number; tmdbType: "movie" | "tv" }> = [];

      for (const i of seeds) {
        const tmdbId = i.tmdbId!;
        const tmdbType = i.tmdbType!;
        const rec = await tmdbRecommendations(tmdbId, tmdbType);

        for (const r of rec.results ?? []) {
          const t = (r.title || r.name || "").trim();
          if (!t) continue;
          if (existingTitles.has(t.toLowerCase())) continue;
          pool.push({ title: t, tmdbId: r.id, tmdbType });
        }
      }

      const [trendMovie, trendTv] = await Promise.all([tmdbTrending("movie"), tmdbTrending("tv")]);

      for (const r of trendMovie.results ?? []) {
        const t = (r.title || r.name || "").trim();
        if (!t) continue;
        if (existingTitles.has(t.toLowerCase())) continue;
        pool.push({ title: t, tmdbId: r.id, tmdbType: "movie" });
      }

      for (const r of trendTv.results ?? []) {
        const t = (r.title || r.name || "").trim();
        if (!t) continue;
        if (existingTitles.has(t.toLowerCase())) continue;
        pool.push({ title: t, tmdbId: r.id, tmdbType: "tv" });
      }

      const seen = new Set<string>();
      const unique = pool.filter((x) => {
        const k = `${x.tmdbType}:${x.tmdbId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (!unique.length) {
        setPickStatus("No new picks found (try rating more items).");
        return;
      }

      const candidates = unique.slice(0, 80);

      const enriched: Array<Pick & { score: number; tags: string[] }> = [];

      for (const c of candidates) {
        try {
          const d = await tmdbDetails(c.tmdbId, c.tmdbType);
          const posterUrl = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : undefined;
          const tags = (d.genres ?? []).map((g) => g.name);

          const typeBoost = c.tmdbType === "movie" ? taste.typePref.movie : taste.typePref.tv;

          const score = scoreCandidate({
            candidateTags: tags,
            userTopTags: taste.topTags,
            typeBoost,
          });

          enriched.push({
            title: c.title,
            tmdbId: c.tmdbId,
            tmdbType: c.tmdbType,
            posterUrl,
            score,
            tags,
          });
        } catch {
          enriched.push({
            title: c.title,
            tmdbId: c.tmdbId,
            tmdbType: c.tmdbType,
            posterUrl: undefined,
            score: 0.1,
            tags: [],
          });
        }
      }

      enriched.sort((a, b) => b.score - a.score);

      if (mode === "random") {
        const top = enriched.slice(0, 30);
        const weights = top.map((x) => Math.max(0.0001, x.score));
        const total = weights.reduce((a, b) => a + b, 0);

        let r = Math.random() * total;
        let chosen = top[top.length - 1];

        for (let i = 0; i < top.length; i++) {
          r -= weights[i];
          if (r <= 0) {
            chosen = top[i];
            break;
          }
        }

        setPicks([{ title: chosen.title, tmdbId: chosen.tmdbId, tmdbType: chosen.tmdbType, posterUrl: chosen.posterUrl }]);
        setPickStatus("Random pick selected.");
        return;
      }

      const diversified = diversifyPicks(enriched, 2);

      setPicks(
        diversified.map((p) => ({
          title: p.title,
          tmdbId: p.tmdbId,
          tmdbType: p.tmdbType,
          posterUrl: p.posterUrl,
        }))
      );

      setPickStatus("Here you go.");
    } catch (e: unknown) {
      setPickStatus(e instanceof Error ? e.message : "Pick failed");
    }
  }

  function toggleExclude(t: MediaType) {
    setExcludeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  /* ================= DRAG & DROP ================= */

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const itemId = String(active.id);
    const newStatus = String(over.id) as Status;

    if (!["completed", "in_progress", "planned", "dropped"].includes(newStatus)) return;

    const item = items.find((x) => x.id === itemId);
    if (!item) return;
    if (item.status === newStatus) return;

    updateItem(itemId, { status: newStatus });
  }

  /* ================= APPLY SUGGESTION ================= */

  const applySuggestion = useCallback(async (s: Suggestion, opts?: { keepManualTags?: boolean }) => {
    const keepManual = opts?.keepManualTags ?? true;

    setAutofillStatus(`Applying: ${s.title}…`);

    setForm((f) => {
      const base = {
        ...f,
        title: s.title,
        posterUrl: s.posterUrl || f.posterUrl,
        runtime: typeof s.runtime === "number" ? s.runtime : f.runtime,
      };

      if (s.provider === "tmdb") {
        return {
          ...base,
          tmdbId: s.tmdbId,
          tmdbType: s.tmdbType,
          igdbId: undefined,
          anilistId: undefined,
          anilistType: undefined,
        };
      }

      if (s.provider === "igdb") {
        return {
          ...base,
          igdbId: s.igdbId,
          tmdbId: undefined,
          tmdbType: undefined,
          anilistId: undefined,
          anilistType: undefined,
        };
      }

      return {
        ...base,
        anilistId: s.anilistId,
        anilistType: s.anilistType,
        tmdbId: undefined,
        tmdbType: undefined,
        igdbId: undefined,
      };
    });

    const newAuto = uniqTags([...(s.tags ?? [])]);
    setAutoTags(newAuto);
    if (!keepManual) setManualTags([]);

    const currentType = (formRef.current?.type as MediaType) ?? "movie";
    const currentStatus = (formRef.current?.status as Status) ?? "completed";

    if (typeof s.progressTotal === "number" && s.progressTotal > 0) {
      setProgressTotalText((prev) => (prev.trim() === "" ? String(s.progressTotal) : prev));
      setProgressCurText((prev) => {
        if (prev.trim() !== "") return prev;
        if (currentStatus === "completed") return String(s.progressTotal);
        return prev;
      });
    } else {
      if (currentType === "movie") {
        setProgressTotalText((prev) => (prev.trim() === "" ? "1" : prev));
        if (currentStatus === "completed") setProgressCurText((prev) => (prev.trim() === "" ? "1" : prev));
      }
    }

    setAutofillStatus("Auto-fill complete.");
  }, []);

  /* ================= AUTO AUTOFILL ================= */

  useEffect(() => {
    if (!autoAutofill) return;
    const title = (form.title || "").trim();
    const type = form.type as MediaType;

    if (!title || title.length < 2) {
      setSuggestions([]);
      setGhostTitle("");
      setShowSuggest(false);
      setActiveSuggestIdx(0);
      return;
    }

    const key = `${type}:${title.toLowerCase()}`;

    if (autofillTimer.current) window.clearTimeout(autofillTimer.current);

    autofillTimer.current = window.setTimeout(async () => {
      try {
        setAutofillStatus("Searching…");

        const pushSuggestions = async (list: Suggestion[]) => {
          const q = title;
          const scored = list
            .map((x) => ({ x, score: similarityScore(q, x.title) }))
            .sort((a, b) => b.score - a.score);

          const top = scored.map((sug) => sug.x).slice(0, 7);
          setSuggestions(top);
          setShowSuggest(true);
          setActiveSuggestIdx(0);

          const top1 = scored[0];
          const bestScore = top1?.score ?? 0;
          const best = top1?.x;

          const qNorm = normTitle(q);
          const bNorm = best ? normTitle(best.title) : "";
          const isCompletion = !!best && bNorm.startsWith(qNorm) && qNorm.length >= 2;
          setGhostTitle(isCompletion ? best!.title : "");

          // Do NOT auto-apply while typing.
          // Only show suggestions + ghost preview. User must select (Enter/click) or Tab-accept.
          setAutofillStatus(best ? `Suggestions ready (${Math.round(bestScore * 100)}% match).` : "No match found.");
          lastAutofillKey.current = ""; // optional: prevents stale "locked" state
        };

        if (type === "movie" || type === "tv") {
          const tmdbType: "movie" | "tv" = type;
          const s = await tmdbSearch(title, tmdbType);
          const results = (s?.results ?? []).slice(0, 7);

          if (!results.length) {
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            setAutofillStatus("No match found on TMDB.");
            return;
          }

          const list: Suggestion[] = results.map((r) => {
            const t = (r.title || r.name || "").trim();
            return {
              key: `tmdb:${tmdbType}:${r.id}`,
              provider: "tmdb",
              title: t,
              subtitle:
                tmdbType === "movie"
                  ? r.release_date
                    ? r.release_date.slice(0, 4)
                    : ""
                  : r.first_air_date
                  ? r.first_air_date.slice(0, 4)
                  : "",
              tmdbId: r.id,
              tmdbType,
            };
          });

          await pushSuggestions(list);
          return;
        }

        if (type === "game") {
          const res = await fetch(`/api/igdb/search?q=${encodeURIComponent(title)}&limit=7`, { method: "GET" });
          const json = (await res.json()) as IgdbSearchResponse;

          if (!res.ok) {
            setAutofillStatus(`IGDB error: ${json.error || "Search failed"}`);
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            return;
          }

          const results = (json.results ?? []).slice(0, 7);
          if (!results.length) {
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            setAutofillStatus("No match found on IGDB.");
            return;
          }

          const list: Suggestion[] = results.map((r) => ({
            key: `igdb:${r.id}`,
            provider: "igdb",
            title: r.name,
            posterUrl: r.coverUrl,
            tags: r.genres,
            igdbId: r.id,
          }));

          await pushSuggestions(list);
          return;
        }

        if (type === "anime" || type === "manga") {
          const anilistType = type === "manga" ? "MANGA" : "ANIME";
          const res = await fetch(`/api/anilist/search?q=${encodeURIComponent(title)}&limit=7&type=${anilistType}`, {
            method: "GET",
          });
          const json = (await res.json()) as AnilistSearchResponse;

          if (!res.ok) {
            setAutofillStatus(`AniList error: ${json.error || "Search failed"}`);
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            return;
          }

          const results = (json.results ?? []).slice(0, 7);
          if (!results.length) {
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            setAutofillStatus("No match found on AniList.");
            return;
          }

          const list: Suggestion[] = results.map((r) => ({
            key: `anilist:${anilistType}:${r.id}`,
            provider: "anilist",
            title: r.title,
            posterUrl: r.coverUrl,
            tags: r.genres,
            anilistId: r.id,
            anilistType,
          }));

          await pushSuggestions(list);
          return;
        }

        setAutofillStatus("");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setAutofillStatus(`Auto-fill error: ${msg}`);
      }
    }, 450);

    return () => {
      if (autofillTimer.current) window.clearTimeout(autofillTimer.current);
    };
  }, [form.title, form.type, autoAutofill, applySuggestion]);

  const selectSuggestion = useCallback(
    async (s: Suggestion) => {
      try {
        setShowSuggest(false);
        setGhostTitle("");
        setAutofillStatus(`Loading details for: ${s.title}…`);

        if (s.provider === "tmdb" && s.tmdbId && (s.tmdbType === "movie" || s.tmdbType === "tv")) {
          const d = await tmdbDetails(s.tmdbId, s.tmdbType);

          const posterUrl = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : undefined;
          const tags = (d.genres ?? []).map((g) => g.name);

          let progressTotal: number | undefined;
          if (s.tmdbType === "movie") progressTotal = 1;
          if (s.tmdbType === "tv" && typeof d.number_of_episodes === "number" && d.number_of_episodes > 0) {
            progressTotal = d.number_of_episodes;
          }

          await applySuggestion(
            {
              ...s,
              posterUrl,
              tags: tags.length ? tags : s.tags,
              runtime: d.runtime ?? d.episode_run_time?.[0] ?? undefined,
              progressTotal,
            },
            { keepManualTags: true }
          );
          return;
        }

        if (s.provider === "anilist" && s.anilistId && (s.anilistType === "ANIME" || s.anilistType === "MANGA")) {
          const d = await anilistDetails(s.anilistId, s.anilistType);
          const tags = d.genres?.length ? d.genres : s.tags;

          let progressTotal: number | undefined;
          if (s.anilistType === "ANIME" && typeof d.episodes === "number" && d.episodes > 0) progressTotal = d.episodes;
          if (s.anilistType === "MANGA") {
            if (typeof d.chapters === "number" && d.chapters > 0) progressTotal = d.chapters;
            else if (typeof d.volumes === "number" && d.volumes > 0) progressTotal = d.volumes;
          }

          await applySuggestion(
            {
              ...s,
              posterUrl: d.coverUrl || s.posterUrl,
              tags,
              progressTotal,
            },
            { keepManualTags: true }
          );
          return;
        }

        if (s.provider === "igdb") {
          await applySuggestion(
            {
              ...s,
              tags: s.tags,
              posterUrl: s.posterUrl,
              progressTotal: undefined,
            },
            { keepManualTags: true }
          );
          return;
        }

        await applySuggestion(s, { keepManualTags: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setAutofillStatus(`Auto-fill error: ${msg}`);
      }
    },
    [applySuggestion]
  );

  /* ================= FILTER ================= */

  const filtered = useMemo(() => {
    let out = items.slice();

    if (view === "completed") out = out.filter((i) => i.status === "completed");
    if (view === "watching") out = out.filter((i) => i.status === "in_progress");
    if (view === "watchlist") out = out.filter((i) => i.status === "planned");
    if (view === "dropped") out = out.filter((i) => i.status === "dropped");

    if (query) {
      const q = query.toLowerCase();
      out = out.filter((i) => [i.title, i.notes, i.tags.join(" ")].some((v) => String(v || "").toLowerCase().includes(q)));
    }

    out.sort((a, b) => {
      if (sortMode === "title") return a.title.localeCompare(b.title);
      if (sortMode === "rating_high") return (b.rating ?? -1) - (a.rating ?? -1);
      if (sortMode === "rating_low") return (a.rating ?? 999) - (b.rating ?? 999);

      const ad = new Date((a.dateFinished ?? a.createdAt) as string).getTime();
      const bd = new Date((b.dateFinished ?? b.createdAt) as string).getTime();
      return sortMode === "oldest" ? ad - bd : bd - ad;
    });

    return out;
  }, [items, view, query, sortMode]);

  const grouped = useMemo(() => {
    if (groupMode === "none") return null;

    const map = new Map<string, MediaItem[]>();
    for (const i of filtered) {
      const baseDate = (i.dateFinished ?? i.createdAt).slice(0, 10);
      const k = toGroupKey(groupMode, baseDate);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(i);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered, groupMode]);

  /* ================= STATS ================= */

  const statusCounts = useMemo(() => {
    const base: Record<Status, number> = { completed: 0, in_progress: 0, planned: 0, dropped: 0 };
    for (const i of items) base[i.status] += 1;
    return base;
  }, [items]);

  const typeCounts = useMemo(() => {
    const map = new Map<MediaType, number>();
    for (const i of items) map.set(i.type, (map.get(i.type) ?? 0) + 1);
    return Array.from(map.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [items]);

  const avgByType = useMemo(() => {
    const map = new Map<MediaType, { sum: number; count: number }>();
    for (const i of items) {
      if (typeof i.rating !== "number") continue;
      const cur = map.get(i.type) ?? { sum: 0, count: 0 };
      cur.sum += i.rating;
      cur.count += 1;
      map.set(i.type, cur);
    }
    return Array.from(map.entries())
      .map(([type, v]) => ({ type, avg: v.count ? v.sum / v.count : 0, count: v.count }))
      .sort((a, b) => b.avg - a.avg);
  }, [items]);

  const totalCompleted = useMemo(() => {
    return items.filter((i) => {
      if (excludeTypes.has(i.type)) return false;
      return i.status === "completed";
    }).length;
  }, [items, excludeTypes]);

  const totalRuntimeMinutesCompleted = useMemo(() => {
    let sum = 0;

    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      // Games: use hoursPlayed if available
      if (i.type === "game") {
        const h = typeof i.hoursPlayed === "number" ? i.hoursPlayed : undefined;
        if (typeof h === "number" && Number.isFinite(h) && h > 0) sum += h * 60;
        continue;
      }

      // Movie: runtime is full runtime
      if (i.type === "movie") {
        if (typeof i.runtime === "number" && Number.isFinite(i.runtime) && i.runtime > 0) sum += i.runtime;
        continue;
      }

      // TV/Anime: runtime is minutes per episode (approx)
      if (i.type === "tv" || i.type === "anime") {
        const perEp = typeof i.runtime === "number" && i.runtime > 0 ? i.runtime : 0;

        const cur =
          typeof i.progressCurOverride === "number"
            ? i.progressCurOverride
            : typeof i.progressCur === "number"
            ? i.progressCur
            : undefined;

        const total =
          typeof i.progressTotalOverride === "number"
            ? i.progressTotalOverride
            : typeof i.progressTotal === "number"
            ? i.progressTotal
            : undefined;

        const episodes = typeof cur === "number" ? cur : typeof total === "number" ? total : 0;

        if (perEp > 0 && episodes > 0) sum += perEp * episodes;
        continue;
      }

      // Books/Manga: not counted in "time watched" (yet)
    }

    return Math.round(sum);
  }, [items, excludeTypes]);

  const rewatchTotals = useMemo(() => {
    let rewatches = 0;
    let itemsRewatched = 0;
    for (const i of items) {
      const c = Math.max(0, Number(i.rewatchCount ?? 0) || 0);
      if (c > 0) {
        itemsRewatched += 1;
        rewatches += c;
      }
    }
    return { itemsRewatched, rewatches };
  }, [items]);

  const topTags = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      for (const t of i.tags ?? []) {
        const k = String(t || "").trim();
        if (!k) continue;
        map.set(k, (map.get(k) ?? 0) + 1);
      }
    }
    return Array.from(map.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [items, excludeTypes]);

  const genreCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      for (const t of i.tags ?? []) {
        const k = String(t || "").trim();
        if (!k) continue;
        map.set(k, (map.get(k) ?? 0) + 1);
      }
    }
    return Array.from(map.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [items, excludeTypes]);

  const monthlyCompleted = useMemo(() => {
    const now = new Date();
    const months: Array<{ key: string; label: string; count: number }> = [];

    for (let back = 11; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const key = `${y}-${m}`;
      const label = d.toLocaleString(undefined, { month: "short" });
      months.push({ key, label, count: 0 });
    }

    const idx = new Map(months.map((x, i) => [x.key, i]));

    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      const dateStr = (i.dateFinished ?? i.createdAt ?? "").slice(0, 7);
      if (!dateStr) continue;

      const pos = idx.get(dateStr);
      if (pos !== undefined) months[pos].count += 1;
    }

    const max = Math.max(1, ...months.map((x) => x.count));
    return { months, max };
  }, [items, excludeTypes]);

  // ✅ Fun stats
  const bestMonth = useMemo(() => {
    const best = monthlyCompleted.months.reduce(
      (acc, m) => (m.count > acc.count ? m : acc),
      { key: "—", label: "—", count: 0 }
    );
    return best;
  }, [monthlyCompleted]);

  const completionStreak = useMemo(() => {
    const daysSet = new Set<string>();

    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      const day = (i.dateFinished ?? i.createdAt ?? "").slice(0, 10);
      if (day) daysSet.add(day);
    }

    const days = Array.from(daysSet).sort(); // ascending YYYY-MM-DD
    if (!days.length) return { longest: 0, current: 0 };

    const toDate = (s: string) => new Date(s + "T00:00:00");
    const diffDays = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));

    let longest = 1;
    let run = 1;

    for (let i = 1; i < days.length; i++) {
      const prev = toDate(days[i - 1]);
      const cur = toDate(days[i]);
      if (diffDays(prev, cur) === 1) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 1;
      }
    }

    const today = todayYMD();
    let current = 0;
    const cursor = new Date(today + "T00:00:00");
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      if (!daysSet.has(key)) break;
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return { longest, current };
  }, [items, excludeTypes]);

  const gameHoursStats = useMemo(() => {
    const games = items.filter((i) => i.type === "game" && !excludeTypes.has(i.type));
    const withHours = games.filter((g) => typeof g.hoursPlayed === "number" && (g.hoursPlayed ?? 0) > 0);

    const totalHours = withHours.reduce((a, b) => a + (b.hoursPlayed ?? 0), 0);
    const avgHours = withHours.length ? totalHours / withHours.length : 0;

    const top = withHours.slice().sort((a, b) => (b.hoursPlayed ?? 0) - (a.hoursPlayed ?? 0))[0];

    return {
      totalHours,
      avgHours,
      topGameTitle: top?.title ?? "—",
      topGameHours: top?.hoursPlayed ?? 0,
    };
  }, [items, excludeTypes]);

  const mostRewatchedItem = useMemo(() => {
    const best = items
      .filter((i) => (Number(i.rewatchCount ?? 0) || 0) > 0)
      .slice()
      .sort((a, b) => (Number(b.rewatchCount ?? 0) || 0) - (Number(a.rewatchCount ?? 0) || 0))[0];

    return best ? { title: best.title, count: Number(best.rewatchCount ?? 0) || 0 } : { title: "—", count: 0 };
  }, [items]);

  const yearGenreCompare = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const thisYearStart = `${y}-01-01`;
    const lastYearStart = `${y - 1}-01-01`;
    const lastYearEnd = `${y - 1}-12-31`;

    const countTags = (start: string, end?: string) => {
      const map = new Map<string, number>();
      for (const i of items) {
        if (i.status !== "completed") continue;
        if (excludeTypes.has(i.type)) continue;

        const d = (i.dateFinished ?? i.createdAt ?? "").slice(0, 10);
        if (!d) continue;
        if (d < start) continue;
        if (end && d > end) continue;

        for (const t of i.tags ?? []) {
          const k = String(t || "").trim();
          if (!k) continue;
          map.set(k, (map.get(k) ?? 0) + 1);
        }
      }
      const top = Array.from(map.entries()).sort((a, b) => b[1] - a[1])[0];
      return top ? { tag: top[0], count: top[1] } : { tag: "—", count: 0 };
    };

    const thisYearTop = countTags(thisYearStart);
    const lastYearTop = countTags(lastYearStart, lastYearEnd);

    return { thisYearTop, lastYearTop, year: y };
  }, [items, excludeTypes]);

  /* ================= UI ================= */

  const displayCombinedTags = useMemo(() => {
    return uniqTags([...(autoTags ?? []), ...(manualTags ?? [])]);
  }, [autoTags, manualTags]);

  return (
    <div className="min-h-screen text-neutral-100 bg-black">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <header className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Stack</h1>
              <p className="text-sm text-neutral-400">Your personal media website</p>
            </div>
            <div className="text-xs text-neutral-500">{saveStatus}</div>
          </div>

          <nav className="flex justify-center">
            <div className="flex items-center gap-2">
              <div className="inline-flex flex-wrap justify-center gap-[clamp(0.35rem,1.2vw,0.6rem)] rounded-2xl bg-neutral-900/40 ring-1 ring-neutral-800/80 px-[clamp(0.4rem,1.6vw,0.7rem)] py-[clamp(0.35rem,1.2vw,0.6rem)] max-w-[92vw]">
                {navMain.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={[
                      "px-[clamp(0.55rem,1.6vw,0.9rem)] py-[clamp(0.45rem,1.2vw,0.65rem)] rounded-xl border text-[clamp(0.72rem,1.2vw,0.9rem)] transition",
                      view === n.key ? "bg-white/15 border-white/20" : "bg-white/5 border-white/10 hover:bg-white/10",
                    ].join(" ")}
                  >
                    {n.label}
                  </Link>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {navActions.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    title={n.label}
                    aria-label={n.label}
                    className={[
                      "h-[clamp(2.25rem,5vw,2.75rem)] w-[clamp(2.25rem,5vw,2.75rem)] grid place-items-center rounded-2xl border transition",
                      "bg-neutral-900/40 ring-1 ring-neutral-800/80",
                      view === n.key ? "bg-white/15 border-white/20" : "bg-white/5 border-white/10 hover:bg-white/10",
                    ].join(" ")}
                  >
                    {n.icon === "plus" ? (
                      <span className="text-[clamp(1.0rem,2.4vw,1.35rem)] leading-none">+</span>
                    ) : (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">◔</span>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          </nav>
        </header>

        {/* STATS PAGE */}
        {view === "stats" ? (
          <div className="space-y-4">
            <div className="grid md:grid-cols-4 gap-4">
              <StatCard title="Total items" value={items.length.toString()} sub={`${statusCounts.completed} completed`} />
              <StatCard title="Completed" value={totalCompleted.toString()} sub="(after excludes)" />
              <StatCard
                title="Time watched (runtime)"
                value={`${(totalRuntimeMinutesCompleted / 60).toFixed(1)}h`}
                sub={`${totalRuntimeMinutesCompleted} min (movies exact; TV/anime estimated; games use hours played)`}
              />
              <StatCard title="Rewatches" value={`${rewatchTotals.rewatches}`} sub={`${rewatchTotals.itemsRewatched} items`} />
            </div>

            {/* ✅ Fun stats row */}
            <div className="grid md:grid-cols-4 gap-4">
              <StatCard title="Best month" value={`${bestMonth.label}`} sub={`${bestMonth.count} completed`} />
              <StatCard title="Current streak" value={`${completionStreak.current} days`} sub={`Longest: ${completionStreak.longest} days`} />
              <StatCard title="Top game" value={gameHoursStats.topGameTitle} sub={`${gameHoursStats.topGameHours.toFixed(1)}h`} />
              <StatCard title="Avg game hours" value={`${gameHoursStats.avgHours.toFixed(1)}h`} sub={`Total: ${gameHoursStats.totalHours.toFixed(1)}h`} />
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Status breakdown</div>
                <div className="space-y-2 text-sm">
                  <BarRow label="Completed" value={statusCounts.completed} total={items.length || 1} />
                  <BarRow label="In Progress" value={statusCounts.in_progress} total={items.length || 1} />
                  <BarRow label="Planned" value={statusCounts.planned} total={items.length || 1} />
                  <BarRow label="Dropped" value={statusCounts.dropped} total={items.length || 1} />
                </div>

                <div className="text-xs text-neutral-400 mt-4">Exclude types (affects stats):</div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {(["movie", "tv", "anime", "manga", "book", "game"] as MediaType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleExclude(t)}
                      className={`px-3 py-1 rounded-xl border text-xs ${
                        excludeTypes.has(t) ? "bg-red-500/15 border-red-500/20" : "bg-white/5 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {excludeTypes.has(t) ? `Excluded: ${TYPE_LABEL[t]}` : TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Type totals</div>
                <div className="space-y-2">
                  {typeCounts.length ? (
                    typeCounts.map((x) => (
                      <div
                        key={x.type}
                        className="flex items-center justify-between rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2"
                      >
                        <div className="text-sm text-neutral-200">{TYPE_LABEL[x.type]}</div>
                        <div className="text-sm text-neutral-300">{x.count}</div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-neutral-400">No items yet.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Average rating (by type)</div>
                <div className="grid sm:grid-cols-2 gap-2 text-sm text-neutral-300">
                  {avgByType.length ? (
                    avgByType.map((x) => (
                      <div key={x.type} className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
                        <div className="text-xs text-neutral-400">{TYPE_LABEL[x.type]}</div>
                        <div>
                          {x.avg.toFixed(1)} <span className="text-xs text-neutral-500">({x.count} rated)</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-neutral-400">Rate some items to see averages.</div>
                  )}
                </div>
              </div>

              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Completed per month (last 12)</div>

                <div className="flex items-end gap-2 h-28">
                  {monthlyCompleted.months.map((m) => {
                    const h = Math.round((m.count / monthlyCompleted.max) * 100);
                    return (
                      <div key={m.key} className="flex-1 min-w-[18px] text-center">
                        <div
                          className="rounded-lg bg-white/10 border border-white/10 mx-auto"
                          style={{ height: `${Math.max(6, h)}%` }}
                          title={`${m.key}: ${m.count}`}
                        />
                        <div className="text-[10px] text-neutral-500 mt-2">{m.label}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="text-xs text-neutral-500 mt-3">Uses date watched if set; otherwise created date.</div>
              </div>
            </div>

            {/* ✅ Year highlights */}
            <div className="grid lg:grid-cols-2 gap-4">
              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Year highlights</div>
                <div className="space-y-2 text-sm text-neutral-300">
                  <div className="flex items-center justify-between rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
                    <div>Top genre this year ({yearGenreCompare.year})</div>
                    <div className="text-neutral-200">
                      {yearGenreCompare.thisYearTop.tag}{" "}
                      <span className="text-neutral-500">({yearGenreCompare.thisYearTop.count})</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
                    <div>Top genre last year ({yearGenreCompare.year - 1})</div>
                    <div className="text-neutral-200">
                      {yearGenreCompare.lastYearTop.tag}{" "}
                      <span className="text-neutral-500">({yearGenreCompare.lastYearTop.count})</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
                    <div>Most rewatched</div>
                    <div className="text-neutral-200">
                      {mostRewatchedItem.title}{" "}
                      <span className="text-neutral-500">({mostRewatchedItem.count})</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Genres (completed)</div>
                {genreCounts.length ? (
                  <div className="flex items-center gap-6">
                    <PieChartSimple data={genreCounts} />
                    <div className="space-y-2 text-sm w-full">
                      {genreCounts.map((g) => (
                        <div key={g.label} className="flex items-center justify-between gap-6">
                          <div className="text-neutral-300 truncate">{g.label}</div>
                          <div className="text-neutral-400">{g.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-neutral-400">No genres yet.</div>
                )}
              </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Top tags / genres (completed)</div>

                {topTags.length ? (
                  <div className="flex flex-wrap gap-2">
                    {topTags.map((t) => (
                      <div
                        key={t.tag}
                        className="px-3 py-1 rounded-xl bg-neutral-950 border border-neutral-800 text-xs text-neutral-200"
                        title={`${t.count} items`}
                      >
                        {t.tag} <span className="text-neutral-500">({t.count})</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-neutral-400">No tags yet (auto-fill adds genres for Movie/TV/Game/Anime/Manga).</div>
                )}
              </div>

              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Notes</div>
                <div className="text-xs text-neutral-400 space-y-2">
                  <div> </div>
                  <div> </div>
                  <div> </div>
                  <div> </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* ADD PAGE */}
        {view === "add" ? (
          <div className="relative overflow-hidden rounded-3xl ring-1 ring-neutral-800/70 bg-[#2a2f8f]/40">
            {/* side curtains */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-y-0 left-0 w-[18%] bg-[#2a2f8f]/90" />
              <div className="absolute inset-y-0 right-0 w-[18%] bg-[#2a2f8f]/90" />
              <div className="absolute inset-y-0 left-[18%] w-[6%] bg-neutral-700/60 blur-2xl" />
              <div className="absolute inset-y-0 right-[18%] w-[6%] bg-neutral-700/60 blur-2xl" />
            </div>

            {/* mascots */}
            <div className="absolute inset-y-0 left-0 w-[18%] hidden md:flex items-center justify-center pointer-events-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/mascot-left.png" alt="Mascot left" className="max-h-[520px] w-auto object-contain opacity-95 drop-shadow-2xl" />
            </div>
            <div className="absolute inset-y-0 right-0 w-[18%] hidden md:flex items-center justify-center pointer-events-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/mascot-right.png" alt="Mascot right" className="max-h-[520px] w-auto object-contain opacity-95 drop-shadow-2xl" />
            </div>

            {/* center content */}
            <div className="relative px-4 sm:px-6 py-6 md:px-10 md:py-10 mx-auto max-w-3xl space-y-4">
              <div className="text-center">
                <div className="text-2xl font-semibold tracking-tight">Add to Stack</div>
                <div className="text-sm text-neutral-200/70 mt-1">
                  Auto-fill: Movie/TV (TMDB) • Game (IGDB) • Anime/Manga (AniList). Everything else manual.
                </div>
              </div>

              <form onSubmit={addItem} className="bg-neutral-950/40 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-4">
                <div className="space-y-2">
                  <div className="relative">
                    {ghostTitle && normTitle(ghostTitle).startsWith(normTitle(String(form.title || ""))) ? (
                      <div className="absolute inset-0 pointer-events-none flex items-center px-3 py-2">
                        <span className="text-transparent select-none">{String(form.title || "")}</span>
                        <span className="text-neutral-500/60 select-none">{ghostTitle.slice(String(form.title || "").length)}</span>
                      </div>
                    ) : null}

                    <input
                      value={form.title || ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        lastAutofillKey.current = "";
                        setForm({ ...form, title: v });
                        setShowSuggest(true);
                      }}
                      onFocus={() => setShowSuggest(true)}
                      onBlur={() => {
                        window.setTimeout(() => setShowSuggest(false), 120);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Tab" && ghostTitle) {
                          e.preventDefault();
                          setForm((f) => ({ ...f, title: ghostTitle }));
                          setGhostTitle("");
                          setShowSuggest(false);
                          const best = suggestions[0];
                          if (best) selectSuggestion(best);
                          return;
                        }

                        if (showSuggest && suggestions.length) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setActiveSuggestIdx((i) => Math.min(suggestions.length - 1, i + 1));
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setActiveSuggestIdx((i) => Math.max(0, i - 1));
                            return;
                          }
                          if (e.key === "Enter") {
                            if (activeSuggestIdx >= 0 && activeSuggestIdx < suggestions.length) {
                              const s = suggestions[activeSuggestIdx];
                              if (s) {
                                e.preventDefault();
                                selectSuggestion(s);
                              }
                            }
                            return;
                          }
                          if (e.key === "Escape") {
                            setShowSuggest(false);
                            return;
                          }
                        }
                      }}
                      placeholder="Title"
                      className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
                    />

                    {showSuggest && suggestions.length ? (
                      <div className="absolute z-30 mt-2 w-full rounded-2xl border border-neutral-800 bg-neutral-950 shadow-xl overflow-hidden">
                        <div className="px-3 py-2 text-[11px] text-neutral-500 border-b border-neutral-800">
                          Suggestions (↑/↓ + Enter) • Tab accepts ghost preview
                        </div>
                        <div className="max-h-64 overflow-auto">
                          {suggestions.map((s, idx) => (
                            <button
                              type="button"
                              key={s.key}
                              onMouseDown={(ev) => ev.preventDefault()}
                              onClick={() => selectSuggestion(s)}
                              className={[
                                "w-full text-left px-3 py-2 flex items-center gap-3 border-b border-neutral-900/60",
                                idx === activeSuggestIdx ? "bg-white/10" : "hover:bg-white/5",
                              ].join(" ")}
                            >
                              <div className="w-8 h-10 rounded-lg bg-neutral-900 border border-neutral-800 overflow-hidden shrink-0">
                                {s.posterUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={s.posterUrl} alt="" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">—</div>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm text-neutral-200 truncate">{s.title}</div>
                                <div className="text-[11px] text-neutral-500">
                                  {s.provider.toUpperCase()}
                                  {s.subtitle ? ` • ${s.subtitle}` : ""}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {autofillStatus ? <div className="text-xs text-neutral-300">{autofillStatus}</div> : null}
                </div>

                {((form.posterOverrideUrl || "").trim() || (form.posterUrl || "").trim()) ? (
                  <div className="flex items-center gap-3 rounded-2xl bg-neutral-950 border border-neutral-800 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={((form.posterOverrideUrl || "").trim() || (form.posterUrl || "").trim()) as string}
                      alt="Poster"
                      className="w-12 h-16 rounded-lg object-cover bg-neutral-900"
                    />
                    <div className="text-xs text-neutral-400">Cover loaded • Tags: {displayCombinedTags.slice(0, 4).join(", ") || "—"}</div>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          posterUrl: "",
                          posterOverrideUrl: "",
                        }))
                      }
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      Remove cover
                    </button>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <Select
                    label="Type"
                    value={form.type || "movie"}
                    onChange={(v) => {
                      setSuggestions([]);
                      setGhostTitle("");
                      setActiveSuggestIdx(0);

                      setForm({
                        ...form,
                        type: v as MediaType,
                        tmdbId: undefined,
                        tmdbType: undefined,
                        igdbId: undefined,
                        anilistId: undefined,
                        anilistType: undefined,
                        posterUrl: "",
                        runtime: undefined,
                      });

                      setAutoTags([]);
                      setAutofillStatus("");

                      setProgressTotalText((prev) => {
                        const nextType = v as MediaType;
                        if (nextType === "movie") return prev.trim() === "" ? "1" : prev;
                        return prev;
                      });
                    }}
                    options={[
                      { value: "movie", label: "Movie" },
                      { value: "tv", label: "TV" },
                      { value: "anime", label: "Anime" },
                      { value: "manga", label: "Manga" },
                      { value: "book", label: "Book" },
                      { value: "game", label: "Game" },
                    ]}
                  />

                  <Select
                    label="Status"
                    value={form.status || "completed"}
                    onChange={(v) => setForm({ ...form, status: v as Status })}
                    options={[
                      { value: "completed", label: "Completed" },
                      { value: "in_progress", label: "In Progress" },
                      { value: "planned", label: "Planned" },
                      { value: "dropped", label: "Dropped" },
                    ]}
                  />

                  <TextNumberInput
                    label="Rating (0–10)"
                    value={ratingText}
                    onChange={setRatingText}
                    placeholder="—"
                    pattern={/^\d{0,2}(\.\d{0,1})?$/}
                    helper="Rate the show."
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextNumberInput
                    label="Progress current (optional)"
                    value={progressCurText}
                    onChange={setProgressCurText}
                    placeholder="—"
                    pattern={/^\d{0,6}$/}
                  />
                  <TextNumberInput
                    label="Progress total (optional)"
                    value={progressTotalText}
                    onChange={setProgressTotalText}
                    placeholder={form.type === "movie" ? "1" : "—"}
                    pattern={/^\d{0,6}$/}
                    helper={
                      form.type === "movie"
                        ? "Movies default to 1 total if left blank."
                        : form.type === "tv"
                        ? "Auto-fill tries to set episode count."
                        : form.type === "anime"
                        ? "Auto-fill tries to set episodes."
                        : form.type === "manga"
                        ? "Auto-fill tries chapters (or volumes)."
                        : undefined
                    }
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Text
                    label="Date watched (optional)"
                    type="date"
                    value={String(form.dateFinished || "")}
                    onChange={(v) => setForm({ ...form, dateFinished: v })}
                    helper="If blank: Completed auto-sets to today."
                  />

                  {String(form.title || "").trim().length > 0 ? (
                    <Text
                      label="Cover image URL (optional)"
                      value={String(form.posterOverrideUrl || "")}
                      onChange={(v) => setForm({ ...form, posterOverrideUrl: v })}
                      helper="Overrides auto-filled cover."
                    />
                  ) : null}
                </div>

                <TagEditor
                  autoTags={autoTags}
                  manualTags={manualTags}
                  onChangeManual={setManualTags}
                  helper="Auto-filled genres show below; add your own tags too."
                />

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Toggle label="In theaters" checked={!!form.inTheaters} onChange={(v) => setForm({ ...form, inTheaters: v })} />

                  <Toggle
                    label="Rewatch"
                    checked={isRewatch}
                    onChange={(v) => {
                      if (v) setRewatchText((prev) => (prev.trim() === "" || Number(prev) === 0 ? "1" : prev));
                      else setRewatchText("0");
                    }}
                  />

                  <TextNumberInput
                    label="Count"
                    value={rewatchText}
                    onChange={setRewatchText}
                    placeholder="0"
                    pattern={/^\d{0,3}$/}
                    disabled={!isRewatch}
                    helper="This still doesnt work as intended ngl"
                  />
                </div>

                <TextArea
                  label="Notes"
                  value={String(form.notes || "")}
                  onChange={(v) => setForm({ ...form, notes: v })}
                  placeholder="Anything you want to remember"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
                  >
                    Add to Stack
                  </button>

                  <div className="flex gap-3 flex-wrap">
                    <Toggle label="Auto-fill as you type" checked={autoAutofill} onChange={setAutoAutofill} />
                  </div>
                </div>
              </form>

              {/* PICK SECTION */}
              <div className="bg-neutral-950/40 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => pickForMe("best")}
                      className="px-4 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
                    >
                      Pick something for me
                    </button>

                    <button
                      type="button"
                      onClick={() => pickForMe("random")}
                      title="Random"
                      aria-label="Random"
                      className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
                    >
                      🎲
                    </button>
                  </div>

                  <div className="text-xs text-neutral-400">{pickStatus}</div>
                </div>

                {picks.length ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {picks.map((p) => (
                      <div key={`${p.tmdbType ?? "x"}:${p.tmdbId ?? p.title}`} className="space-y-2">
                        <div className="aspect-[2/3] rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800">
                          {p.posterUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.posterUrl} alt={p.title} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
                          )}
                        </div>
                        <div className="text-xs text-neutral-200 line-clamp-2">{p.title}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* LIST PAGES */}
        {view !== "stats" && view !== "add" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, notes, tags..."
                className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
              />

              <Select
                label="Sort"
                value={sortMode}
                onChange={(v) => setSortMode(v as SortMode)}
                options={[
                  { value: "newest", label: "Newest first" },
                  { value: "oldest", label: "Oldest first" },
                  { value: "title", label: "Title (A–Z)" },
                  { value: "rating_high", label: "Rating (high → low)" },
                  { value: "rating_low", label: "Rating (low → high)" },
                ]}
              />
            </div>

            {view === "all" ? (
              <div className="flex items-center justify-between">
                <div className="text-xs text-neutral-500">Board view lets you drag cards between statuses.</div>
                <Toggle label="Board view" checked={boardView} onChange={setBoardView} />
              </div>
            ) : null}

            <DndContext onDragEnd={handleDragEnd}>
              {view === "all" && boardView ? (
                <BoardView items={filtered} onDelete={removeItem} onUpdate={updateItem} />
              ) : groupMode !== "none" && grouped ? (
                <div className="space-y-6">
                  {grouped.map(([k, list]) => (
                    <section key={k} className="space-y-2">
                      <h3 className="text-sm text-neutral-400">{k}</h3>
                      <div className="space-y-3">
                        {list.map((i) => (
                          <MALRow key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={(patch) => updateItem(i.id, patch)} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="hidden sm:grid grid-cols-[72px_minmax(0,1fr)_minmax(72px,12%)_minmax(72px,12%)_minmax(140px,20%)] gap-3 px-3 py-2 rounded-xl bg-neutral-900/40 ring-1 ring-neutral-800/70 text-xs text-neutral-300">
                    <div />
                    <div>Title</div>
                    <div className="text-center">Score</div>
                    <div className="text-center">Type</div>
                    <div className="text-center">Progress / Hours</div>
                  </div>

                  {filtered.map((i) => (
                    <MALRow key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={(patch) => updateItem(i.id, patch)} />
                  ))}
                </div>
              )}
            </DndContext>
          </div>
        ) : null}

        <footer className="pt-6 text-xs text-neutral-500">Stack • Saves to Supabase + local backup</footer>
      </div>

      {/* ✅ UNDO TOAST */}
      {undoState ? (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-3 rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl px-4 py-3">
            <div className="text-sm text-neutral-200">
              Deleted <span className="font-semibold">{undoState.item.title}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setItems((prev) => {
                  const next = prev.slice();
                  next.splice(undoState.index, 0, undoState.item);
                  return next;
                });
                setUndoState(null);
                if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
                undoTimerRef.current = null;
              }}
              className="text-xs px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => {
                setUndoState(null);
                if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
                undoTimerRef.current = null;
              }}
              className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ================= BOARD VIEW ================= */

function BoardView({
  items,
  onDelete,
  onUpdate,
}: {
  items: MediaItem[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<MediaItem>) => void;
}) {
  const byStatus = useMemo(() => {
    const map: Record<Status, MediaItem[]> = { completed: [], in_progress: [], planned: [], dropped: [] };
    for (const i of items) map[i.status].push(i);
    return map;
  }, [items]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {STATUSES.map((s) => (
        <StatusColumn key={s.id} status={s.id} title={s.label}>
          <div className="space-y-3">
            {byStatus[s.id].map((i) => (
              <CardDraggable key={i.id} item={i} onDelete={() => onDelete(i.id)} onUpdate={(p) => onUpdate(i.id, p)} />
            ))}
            {!byStatus[s.id].length ? <div className="text-xs text-neutral-600 text-center py-8">Drop here</div> : null}
          </div>
        </StatusColumn>
      ))}
    </div>
  );
}

function StatusColumn({ status, title, children }: { status: Status; title: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      className={[
        "rounded-2xl ring-1 shadow-sm p-3 min-h-[240px]",
        isOver ? "ring-emerald-500/40 bg-emerald-500/5" : "ring-neutral-800/80 bg-neutral-900/40",
      ].join(" ")}
    >
      <div className="text-sm font-medium mb-3 text-neutral-200">{title}</div>
      {children}
    </section>
  );
}

/* ================= MAL ROW ================= */

function MALRow({
  item,
  onDelete,
  onUpdate,
}: {
  item: MediaItem;
  onDelete: () => void;
  onUpdate: (patch: Partial<MediaItem>) => void;
}) {
  const displayPoster = item.posterOverrideUrl || item.posterUrl;

  // ---------------- EDITING ----------------
  const [isEditing, setIsEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(item.title);
  const [draftDate, setDraftDate] = React.useState(item.dateFinished ?? "");
  const [draftRating, setDraftRating] = React.useState(typeof item.rating === "number" ? String(item.rating) : "");
  const [draftNotes, setDraftNotes] = React.useState(item.notes ?? "");

  // full note modal
  const [showFullNote, setShowFullNote] = React.useState(false);

  // keep drafts in sync if item changes while not editing
  useEffect(() => {
    if (isEditing) return;
    setDraftTitle(item.title);
    setDraftDate(item.dateFinished ?? "");
    setDraftRating(typeof item.rating === "number" ? String(item.rating) : "");
    setDraftNotes(item.notes ?? "");
  }, [item.id, item.title, item.dateFinished, item.rating, item.notes, isEditing]);

  const cancelEdit = () => {
    setIsEditing(false);
    setDraftTitle(item.title);
    setDraftDate(item.dateFinished ?? "");
    setDraftRating(typeof item.rating === "number" ? String(item.rating) : "");
    setDraftNotes(item.notes ?? "");
  };

  const saveEdit = () => {
    const nextTitle = String(draftTitle || "").trim();
    const nextDate = String(draftDate || "").trim();

    const ratingRaw = String(draftRating || "").trim();
    const ratingNum = ratingRaw === "" ? undefined : Number(ratingRaw);
    const nextRating =
      typeof ratingNum === "number" && Number.isFinite(ratingNum) ? clamp(ratingNum, 0, 10) : undefined;

    const notesRaw = String(draftNotes || "").trim();
    const nextNotes = notesRaw ? notesRaw : undefined;

    onUpdate({
      title: nextTitle || item.title,
      dateFinished: nextDate ? nextDate : undefined,
      rating: nextRating,
      notes: nextNotes,
    });

    setIsEditing(false);
  };

  // ---------------- PROGRESS / HOURS ----------------
  const movieProg = getMovieProgressDefaults(item);

  const cur =
    item.type === "movie"
      ? movieProg.cur
      : typeof item.progressCurOverride === "number"
      ? item.progressCurOverride
      : item.progressCur;

  const total =
    item.type === "movie"
      ? movieProg.total
      : typeof item.progressTotalOverride === "number"
      ? item.progressTotalOverride
      : item.progressTotal;

  const hasCur = typeof cur === "number";
  const hasTotal = typeof total === "number";
  const progressText = hasCur || hasTotal ? (hasTotal ? `${cur ?? 0} / ${total}` : `${cur ?? 0}`) : "—";

  const incCur = () => {
    const base = typeof item.progressCur === "number" ? item.progressCur : 0;
    const t = typeof total === "number" ? total : undefined;
    const next = t ? Math.min(t, base + 1) : base + 1;
    if (item.type === "movie") return onUpdate({ progressCur: Math.min(1, next), progressTotal: 1 });
    onUpdate({ progressCur: next });
  };

  const decCur = () => {
    const base = typeof item.progressCur === "number" ? item.progressCur : 0;
    const next = Math.max(0, base - 1);
    if (item.type === "movie") return onUpdate({ progressCur: Math.min(1, next), progressTotal: 1 });
    onUpdate({ progressCur: next });
  };

  const isGame = item.type === "game";
  const hoursText = typeof item.hoursPlayed === "number" ? `${item.hoursPlayed.toFixed(1)}h` : "—";

  const hasLongNote = !!item.notes && item.notes.length > 120;

  return (
    <>
      {/* FULL NOTE MODAL */}
      {showFullNote ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={() => setShowFullNote(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-800">
              <div className="text-sm text-neutral-200 font-medium truncate">{item.title}</div>
              <button
                type="button"
                onClick={() => setShowFullNote(false)}
                className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
              >
                Close
              </button>
            </div>
            <div className="p-4">
              <div className="text-xs text-neutral-500 mb-2">Full note</div>
              <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">{item.notes || "—"}</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl bg-neutral-900/50 ring-1 ring-neutral-800/80 overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-[72px_minmax(0,1fr)_minmax(72px,12%)_minmax(72px,12%)_minmax(140px,20%)] gap-3 p-3 items-center">
          {/* Poster */}
          <div className="w-[72px] h-[96px] rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800">
            {displayPoster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
            )}
          </div>

          {/* Title + meta */}
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {/* TITLE */}
                {isEditing ? (
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="w-full rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-sm outline-none focus:border-neutral-500"
                    placeholder="Title"
                  />
                ) : (
                  <div className="font-semibold truncate">{item.title}</div>
                )}

                {/* STATUS + DATE */}
                <div className="text-xs text-neutral-400 mt-1 flex flex-wrap items-center gap-2">
                  <span>Status:</span>
                  <select
                    value={item.status}
                    onChange={(e) => onUpdate({ status: e.target.value as Status })}
                    className="rounded-md bg-neutral-950 border border-neutral-800 px-2 py-[2px] text-xs outline-none focus:border-neutral-500"
                  >
                    <option value="completed">Completed</option>
                    <option value="in_progress">In Progress</option>
                    <option value="planned">Planned</option>
                    <option value="dropped">Dropped</option>
                  </select>

                  <span className="text-neutral-600">•</span>

                  {isEditing ? (
                    <input
                      type="date"
                      value={draftDate}
                      onChange={(e) => setDraftDate(e.target.value)}
                      className="rounded-md bg-neutral-950 border border-neutral-800 px-2 py-[2px] text-xs outline-none focus:border-neutral-500"
                      title="Date watched"
                    />
                  ) : item.dateFinished ? (
                    <span className="text-neutral-500">{item.dateFinished}</span>
                  ) : (
                    <span className="text-neutral-600">No date</span>
                  )}
                </div>

                {/* NOTES */}
                {isEditing ? (
                  <div className="mt-2">
                    <div className="text-[11px] text-neutral-500 mb-1">Note</div>
                    <textarea
                      value={draftNotes}
                      onChange={(e) => setDraftNotes(e.target.value)}
                      rows={3}
                      className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500 resize-none"
                      placeholder="Write a note…"
                    />
                  </div>
                ) : item.notes ? (
                  <div className="mt-2">
                    <div className="text-xs text-neutral-300 line-clamp-2">{item.notes}</div>
                    <div className="mt-1 flex items-center gap-2">
                      {hasLongNote ? (
                        <button
                          type="button"
                          onClick={() => setShowFullNote(true)}
                          className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-200"
                        >
                          Read full note
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* TAGS */}
                {item.tags?.length ? (
                  <div className="text-[11px] text-neutral-500 mt-1 truncate">{item.tags.join(" • ")}</div>
                ) : null}
              </div>

              {/* ACTIONS */}
              <div className="flex items-center gap-2 shrink-0">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={saveEdit}
                      className="text-xs px-3 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
                      title="Save"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                      title="Cancel"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsEditing(true)}
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                      title="Edit"
                    >
                      Edit
                    </button>
                    <button
                      onClick={onDelete}
                      className="text-xs px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
                      title="Delete"
                      type="button"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* SCORE */}
          <div className="text-center text-sm text-neutral-300 tabular-nums">
            {isEditing ? (
              <input
                value={draftRating}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || /^\d{0,2}(\.\d{0,1})?$/.test(v)) setDraftRating(v);
                }}
                placeholder="—"
                className="w-[5.5rem] text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                title="Rating (0–10)"
              />
            ) : typeof item.rating === "number" ? (
              item.rating.toFixed(1)
            ) : (
              "—"
            )}
          </div>

          {/* TYPE */}
          <div className="text-center text-sm text-neutral-300">{TYPE_LABEL[item.type]}</div>

          {/* PROGRESS / HOURS */}
          <div className="text-center w-full">
            {isGame ? (
              <>
                <div className="text-sm text-neutral-200 tabular-nums whitespace-nowrap">{hoursText}</div>

                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <span className="text-[11px] text-neutral-500">Hours</span>
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    value={typeof item.hoursPlayed === "number" ? item.hoursPlayed : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") return onUpdate({ hoursPlayed: undefined });
                      const n = Math.max(0, Number(v) || 0);
                      onUpdate({ hoursPlayed: n });
                    }}
                    className="w-[min(6rem,100%)] text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                    placeholder="—"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={decCur}
                    className="h-[2.1rem] w-[2.1rem] rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
                    aria-label="Decrease progress"
                    title="Decrease progress"
                  >
                    −
                  </button>

                  <div className="min-w-0 px-2 text-sm text-neutral-200 tabular-nums whitespace-nowrap">{progressText}</div>

                  <button
                    type="button"
                    onClick={incCur}
                    className="h-[2.1rem] w-[2.1rem] rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
                    aria-label="Increase progress"
                    title="Increase progress"
                  >
                    +
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <span className="text-[11px] text-neutral-500">Total</span>
                  <input
                    type="number"
                    min={0}
                    value={
                      item.type === "movie"
                        ? 1
                        : typeof item.progressTotalOverride === "number"
                        ? item.progressTotalOverride
                        : typeof item.progressTotal === "number"
                        ? item.progressTotal
                        : ""
                    }
                    onChange={(e) => {
                      if (item.type === "movie") return;
                      const v = e.target.value;
                      if (v === "") return onUpdate({ progressTotal: undefined, progressTotalOverride: undefined });
                      const n = Math.max(0, Number(v) || 0);
                      onUpdate({ progressTotalOverride: n });
                    }}
                    className="w-[min(6rem,100%)] text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                    placeholder="—"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ================= DRAGGABLE CARD (BOARD) ================= */

function CardDraggable({
  item,
  onDelete,
  onUpdate,
}: {
  item: MediaItem;
  onDelete: () => void;
  onUpdate: (patch: Partial<MediaItem>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });

  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : {};

  const displayPoster = item.posterOverrideUrl || item.posterUrl;

  const movieProg = getMovieProgressDefaults(item);
  const cur =
    item.type === "movie"
      ? movieProg.cur
      : typeof item.progressCurOverride === "number"
      ? item.progressCurOverride
      : item.progressCur;
  const total =
    item.type === "movie"
      ? movieProg.total
      : typeof item.progressTotalOverride === "number"
      ? item.progressTotalOverride
      : item.progressTotal;

  const progressText =
    typeof cur === "number" || typeof total === "number"
      ? typeof total === "number"
        ? `${cur ?? 0} / ${total}`
        : `${cur ?? 0}`
      : "—";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        "rounded-2xl bg-neutral-950/60 border border-neutral-800 shadow-sm overflow-hidden",
        isDragging ? "opacity-70" : "opacity-100",
      ].join(" ")}
    >
      {/* drag handle row */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 bg-neutral-950 border-b border-neutral-800"
        {...listeners}
        {...attributes}
        style={{ cursor: "grab" }}
      >
        <div className="text-xs text-neutral-500">Drag</div>
        <div className="text-xs text-neutral-400">{TYPE_LABEL[item.type]}</div>
      </div>

      <div className="p-3 flex gap-3">
        <div className="w-12 h-16 rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 shrink-0">
          {displayPoster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">—</div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm text-neutral-200 truncate">{item.title}</div>
          <div className="text-[11px] text-neutral-500 mt-1">
            {item.type === "game"
              ? `Hours: ${typeof item.hoursPlayed === "number" ? `${item.hoursPlayed.toFixed(1)}h` : "—"}`
              : `Progress: ${progressText}`}
          </div>

          <div className="flex items-center justify-between mt-3">
            <select
              value={item.status}
              onChange={(e) => onUpdate({ status: e.target.value as Status })}
              className="rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
            >
              <option value="completed">Completed</option>
              <option value="in_progress">In Progress</option>
              <option value="planned">Planned</option>
              <option value="dropped">Dropped</option>
            </select>

            <button
              type="button"
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= SMALL UI COMPONENTS ================= */

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="bg-neutral-900/50 p-4 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
      <div className="text-xs text-neutral-400">{title}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1">{value}</div>
      {sub ? <div className="text-[11px] text-neutral-500 mt-1">{sub}</div> : null}
    </div>
  );
}

function BarRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-neutral-300">{label}</div>
        <div className="text-neutral-400 tabular-nums">
          {value} <span className="text-neutral-600">({pct}%)</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-white/5 border border-white/10 overflow-hidden">
        <div className="h-full bg-white/15" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Simple pie chart (SVG) — no colors specified manually; uses opacity variations.
 */
function PieChartSimple({ data }: { data: Array<{ label: string; value: number }> }) {
  const total = Math.max(1, data.reduce((a, b) => a + (b.value || 0), 0));
  let acc = 0;

  const r = 38;
  const cx = 45;
  const cy = 45;

  const slices = data.map((d, idx) => {
    const v = Math.max(0, d.value || 0);
    const start = (acc / total) * Math.PI * 2;
    acc += v;
    const end = (acc / total) * Math.PI * 2;

    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);

    const largeArc = end - start > Math.PI ? 1 : 0;

    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;

    // opacity ladder for visual distinction without hardcoding colors
    const opacity = 0.08 + (idx % 8) * 0.06;

    return <path key={d.label} d={path} fill="white" fillOpacity={opacity} stroke="white" strokeOpacity={0.08} />;
  });

  return (
    <div className="shrink-0">
      <svg width={90} height={90} viewBox="0 0 90 90" className="block">
        <circle cx={cx} cy={cy} r={r} fill="transparent" stroke="white" strokeOpacity={0.08} />
        {slices}
      </svg>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      {label ? <div className="text-xs text-neutral-400 mb-1">{label}</div> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={[
        "w-full sm:w-auto px-3 py-2 rounded-xl border text-sm transition text-left",
        checked ? "bg-emerald-500/15 border-emerald-500/20" : "bg-white/5 border-white/10 hover:bg-white/10",
      ].join(" ")}
      aria-pressed={checked}
    >
      <span className="text-neutral-200">{label}</span>
      <span className="ml-2 text-xs text-neutral-500">{checked ? "On" : "Off"}</span>
    </button>
  );
}

function Text({
  label,
  value,
  onChange,
  helper,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  helper?: string;
  type?: React.HTMLInputTypeAttribute;
}) {
  return (
    <label className="block">
      <div className="text-xs text-neutral-400 mb-1">{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500"
      />
      {helper ? <div className="text-[11px] text-neutral-500 mt-1">{helper}</div> : null}
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="text-xs text-neutral-400 mb-1">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500 resize-none"
      />
    </label>
  );
}

function TextNumberInput({
  label,
  value,
  onChange,
  placeholder,
  pattern,
  helper,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  pattern: RegExp;
  helper?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-xs text-neutral-400 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || pattern.test(v)) onChange(v);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={[
          "w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500",
          disabled ? "opacity-50 cursor-not-allowed" : "",
        ].join(" ")}
      />
      {helper ? <div className="text-[11px] text-neutral-500 mt-1">{helper}</div> : null}
    </label>
  );
}

function TagEditor({
  autoTags,
  manualTags,
  onChangeManual,
  helper,
}: {
  autoTags: string[];
  manualTags: string[];
  onChangeManual: (tags: string[]) => void;
  helper?: string;
}) {
  const [text, setText] = useState("");

  const add = () => {
    const parts = text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!parts.length) return;

    const next = uniqTags([...(manualTags ?? []), ...parts]);
    onChangeManual(next);
    setText("");
  };

  const remove = (t: string) => {
    const next = (manualTags ?? []).filter((x) => x.toLowerCase() !== t.toLowerCase());
    onChangeManual(next);
  };


  return (
    <div className="space-y-2">
      <div className="text-xs text-neutral-400">Tags</div>

      <div className="flex flex-wrap gap-2">
        {(autoTags ?? []).map((t) => (
          <span
            key={`a:${t}`}
            className="px-3 py-1 rounded-xl bg-white/5 border border-white/10 text-xs text-neutral-200"
            title="Auto-filled"
          >
            {t}
          </span>
        ))}

        {(manualTags ?? []).map((t) => (
          <button
            key={`m:${t}`}
            type="button"
            onClick={() => remove(t)}
            className="px-3 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-neutral-200 hover:bg-emerald-500/15"
            title="Click to remove"
          >
            {t} <span className="text-neutral-400">×</span>
          </button>
        ))}

        {!autoTags?.length && !manualTags?.length ? <div className="text-xs text-neutral-600">No tags yet.</div> : null}
      </div>

      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add tags (comma separated)"
          className="flex-1 rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <button type="button" onClick={add} className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15">
          Add
        </button>
      </div>

      {helper ? <div className="text-[11px] text-neutral-500">{helper}</div> : null}
    </div>
  );
}