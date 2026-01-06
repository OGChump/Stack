"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  posterUrl?: string;

  // TMDB fields (movie/tv only)
  tmdbId?: number;
  tmdbType?: "movie" | "tv";

  inTheaters?: boolean;
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;
  rewatchCount?: number;
  runtime?: number;
  status: Status;
  tags: string[];
  createdAt: string; // ISO

  // Optional progress (anime/manga/books/games)
  progressCur?: number;
  progressTotal?: number;
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
};

type TmdbRecommendationsResult = {
  results?: Array<{
    id: number;
    title?: string;
    name?: string;
    poster_path?: string | null;
  }>;
};

type PickRec = {
  title: string;
  tmdbId: number;
  tmdbType: "movie" | "tv";
  posterUrl?: string;
};

const LOCAL_BACKUP_KEY = "stack-items-backup-v1";

const STATUSES: Array<{ id: Status; label: string }> = [
  { id: "completed", label: "Completed" },
  { id: "in_progress", label: "Watching" },
  { id: "planned", label: "Watchlist" },
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

/* ================= APP ================= */

export default function StackApp({ view = "all" }: { view?: StackView }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  const [query, setQuery] = useState("");

  // If you want grouping later, re-add the UI. For now, keep it fixed to "none".
  const groupMode: GroupMode = "none";
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const [boardView, setBoardView] = useState(true);

  const [autofillStatus, setAutofillStatus] = useState("");
  const [autoAutofill, setAutoAutofill] = useState(true);
  const autofillTimer = useRef<number | null>(null);
  const lastAutofillKey = useRef<string>("");

  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  const [picks, setPicks] = useState<PickRec[]>([]);
  const [pickStatus, setPickStatus] = useState("");

  const [excludeTypes, setExcludeTypes] = useState<Set<MediaType>>(new Set());

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
    tmdbId: undefined,
    tmdbType: undefined,
    progressCur: undefined,
    progressTotal: undefined,
  });

  const isRewatch = (form.rewatchCount ?? 0) > 0;

  /* ================= NAV ================= */

  const nav = useMemo(
    () => [
      { href: "/", label: "All", key: "all" as StackView },
      { href: "/watching", label: "Currently Watching", key: "watching" as StackView },
      { href: "/completed", label: "Completed", key: "completed" as StackView },
      { href: "/watchlist", label: "Plan to Watch", key: "watchlist" as StackView },
      { href: "/dropped", label: "Dropped", key: "dropped" as StackView },
      { href: "/stats", label: "Stats", key: "stats" as StackView },
      { href: "/add", label: "Add", key: "add" as StackView },
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
  }, [items, userId, cloudLoaded, saveCloud, saveLocalBackup]);

  /* ================= ACTIONS ================= */

  function addItem(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!form.title) return;

    const status = (form.status as Status) ?? "completed";

    const manualDate = (form.dateFinished || "").trim();
    const autoDate = status === "completed" ? todayYMD() : "";
    const finalDate = manualDate || autoDate || undefined;

    const rating =
      typeof form.rating === "number" && Number.isFinite(form.rating)
        ? Math.max(0, Math.min(10, form.rating))
        : undefined;

    const item: MediaItem = {
      id: uid(),
      title: String(form.title).trim(),
      type: form.type as MediaType,
      status,
      inTheaters: !!form.inTheaters,
      dateFinished: finalDate,
      posterUrl: (form.posterUrl || "").trim() || undefined,
      runtime: typeof form.runtime === "number" ? form.runtime : undefined,
      notes: (form.notes || "").trim() || undefined,
      tags: form.tags ?? [],
      rewatchCount: Math.max(0, Number(form.rewatchCount ?? 0) || 0),
      createdAt: new Date().toISOString(),
      rating,
      tmdbId: typeof form.tmdbId === "number" ? form.tmdbId : undefined,
      tmdbType: form.tmdbType === "movie" || form.tmdbType === "tv" ? form.tmdbType : undefined,
      progressCur: typeof form.progressCur === "number" ? form.progressCur : undefined,
      progressTotal: typeof form.progressTotal === "number" ? form.progressTotal : undefined,
    };

    setItems((p) => [item, ...p]);

    setAutofillStatus("");
    setForm((prev) => ({
      title: "",
      type: prev.type ?? "movie",
      status: "completed",
      tags: [],
      inTheaters: false,
      notes: "",
      dateFinished: "",
      posterUrl: "",
      runtime: undefined,
      rewatchCount: 0,
      rating: undefined,
      tmdbId: undefined,
      tmdbType: undefined,
      progressCur: undefined,
      progressTotal: undefined,
    }));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function updateItem(id: string, patch: Partial<MediaItem>) {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  async function pickForMe() {
    try {
      setPickStatus("Finding picks…");
      setPicks([]);

      const liked = items
        .filter((i) => i.tmdbId && (i.tmdbType === "movie" || i.tmdbType === "tv"))
        .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
        .slice(0, 5);

      if (!liked.length) {
        setPickStatus("Rate + auto-fill at least one Movie/TV item first.");
        return;
      }

      const existingTitles = new Set(items.map((i) => i.title.toLowerCase()));
      const all: PickRec[] = [];

      for (const seed of liked) {
        const tmdbType = seed.tmdbType;
        const tmdbId = seed.tmdbId;
        if (!tmdbType || !tmdbId) continue;

        const rec = await tmdbRecommendations(tmdbId, tmdbType);

        for (const r of rec.results ?? []) {
          const t = (r.title || r.name || "").trim();
          if (!t) continue;
          if (existingTitles.has(t.toLowerCase())) continue;

          const posterUrl = r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : undefined;

          all.push({
            title: t,
            tmdbId: r.id,
            tmdbType,
            posterUrl,
          });
        }
      }

      // Unique by tmdbId + type
      const seen = new Set<string>();
      const unique: PickRec[] = [];
      for (const p of all) {
        const k = `${p.tmdbType}:${p.tmdbId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(p);
        if (unique.length >= 10) break;
      }

      setPicks(unique);
      setPickStatus(unique.length ? "Click a poster to autofill it." : "No new picks found (try rating more items).");
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

  /* ================= AUTO AUTOFILL (DEBOUNCED) ================= */

  useEffect(() => {
    if (!autoAutofill) return;

    const title = (form.title || "").trim();
    const type = form.type;

    if (!title || title.length < 3) return;
    if (type !== "movie" && type !== "tv") return;

    const key = `${type}:${title.toLowerCase()}`;
    if (lastAutofillKey.current === key) return;

    if (autofillTimer.current) window.clearTimeout(autofillTimer.current);

    autofillTimer.current = window.setTimeout(async () => {
      try {
        setAutofillStatus("Searching TMDB…");
        const tmdbType: "movie" | "tv" = type;

        const s = await tmdbSearch(title, tmdbType);
        const hit = s?.results?.[0];
        if (!hit) {
          setAutofillStatus("No match found on TMDB.");
          return;
        }

        lastAutofillKey.current = key;
        setAutofillStatus(`Found: ${hit.title || hit.name || "Match"}`);

        const d = await tmdbDetails(hit.id, tmdbType);

        setForm((f) => ({
          ...f,
          tmdbId: hit.id,
          tmdbType,
          posterUrl: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : f.posterUrl,
          runtime: d.runtime ?? d.episode_run_time?.[0] ?? f.runtime,
          tags: (d.genres ?? []).map((g) => g.name),
        }));

        setAutofillStatus("Auto-fill complete.");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setAutofillStatus(`TMDB error: ${msg}`);
      }
    }, 650);

    return () => {
      if (autofillTimer.current) window.clearTimeout(autofillTimer.current);
    };
  }, [form.title, form.type, autoAutofill]);

  /* ================= FILTER ================= */

  const filtered = useMemo(() => {
    let out = items.slice();

    if (view === "completed") out = out.filter((i) => i.status === "completed");
    if (view === "watching") out = out.filter((i) => i.status === "in_progress");
    if (view === "watchlist") out = out.filter((i) => i.status === "planned");
    if (view === "dropped") out = out.filter((i) => i.status === "dropped");

    if (query) {
      const q = query.toLowerCase();
      out = out.filter((i) =>
        [i.title, i.notes, i.tags.join(" ")].some((v) => String(v || "").toLowerCase().includes(q))
      );
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
    const base: Record<Status, number> = {
      completed: 0,
      in_progress: 0,
      planned: 0,
      dropped: 0,
    };
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
      .map(([type, v]) => ({
        type,
        avg: v.count ? v.sum / v.count : 0,
        count: v.count,
      }))
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
      if (typeof i.runtime === "number" && Number.isFinite(i.runtime) && i.runtime > 0) sum += i.runtime;
    }
    return sum;
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
  }, [items]);

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

  /* ================= UI ================= */

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
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

          {/* Centered tabs */}
          <nav className="flex justify-center">
            <div className="inline-flex flex-wrap justify-center gap-2 rounded-2xl bg-neutral-900/40 ring-1 ring-neutral-800/80 px-2 py-2">
              {nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={[
                    "px-3 py-2 rounded-xl border text-sm transition",
                    view === n.key ? "bg-white/15 border-white/20" : "bg-white/5 border-white/10 hover:bg-white/10",
                  ].join(" ")}
                >
                  {n.label}
                </Link>
              ))}
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
                value={`${Math.floor(totalRuntimeMinutesCompleted / 60)}h`}
                sub={`${totalRuntimeMinutesCompleted} min tracked`}
              />
              <StatCard
                title="Rewatches"
                value={`${rewatchTotals.rewatches}`}
                sub={`${rewatchTotals.itemsRewatched} items rewatched`}
              />
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Status breakdown</div>
                <div className="space-y-2 text-sm">
                  <BarRow label="Completed" value={statusCounts.completed} total={items.length || 1} />
                  <BarRow label="Watching" value={statusCounts.in_progress} total={items.length || 1} />
                  <BarRow label="Watchlist" value={statusCounts.planned} total={items.length || 1} />
                  <BarRow label="Dropped" value={statusCounts.dropped} total={items.length || 1} />
                </div>

                <div className="text-xs text-neutral-400 mt-4">Exclude types (affects some stats):</div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {(["movie", "tv", "anime", "manga", "book", "game"] as MediaType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleExclude(t)}
                      className={`px-3 py-1 rounded-xl border text-xs ${
                        excludeTypes.has(t)
                          ? "bg-red-500/15 border-red-500/20"
                          : "bg-white/5 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {excludeTypes.has(t) ? `Excluded: ${t}` : t}
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
                        <div className="text-sm text-neutral-200">{x.type}</div>
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
                        <div className="text-xs text-neutral-400">{x.type}</div>
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
                <div className="text-xs text-neutral-400">No tags yet (TMDB autofill adds genres for Movie/TV).</div>
              )}
            </div>
          </div>
        ) : null}

        {/* ADD PAGE WITH LEFT/RIGHT MASCOTS */}
        {view === "add" ? (
          <div className="relative overflow-hidden rounded-3xl ring-1 ring-neutral-800/70 bg-neutral-900/25">
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-y-0 left-0 w-[18%] bg-[#2a2f8f]/90" />
              <div className="absolute inset-y-0 right-0 w-[18%] bg-[#2a2f8f]/90" />
              <div className="absolute inset-y-0 left-[18%] w-[6%] bg-neutral-700/60 blur-2xl" />
              <div className="absolute inset-y-0 right-[18%] w-[6%] bg-neutral-700/60 blur-2xl" />
            </div>

            <div className="absolute inset-y-0 left-0 w-[18%] hidden md:flex items-center justify-center pointer-events-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/mascot-left.png"
                alt="Mascot left"
                className="max-h-[520px] w-auto object-contain opacity-95 drop-shadow-2xl"
              />
            </div>
            <div className="absolute inset-y-0 right-0 w-[18%] hidden md:flex items-center justify-center pointer-events-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/mascot-right.png"
                alt="Mascot right"
                className="max-h-[520px] w-auto object-contain opacity-95 drop-shadow-2xl"
              />
            </div>

            <div className="relative px-4 sm:px-6 py-6 md:px-10 md:py-10 mx-auto max-w-3xl space-y-4">
              <div className="text-center">
                <div className="text-2xl font-semibold tracking-tight">Add to Stack</div>
                <div className="text-sm text-neutral-400 mt-1">Search / autofill Movie + TV, or add anything manually.</div>
              </div>

              {/* FORM FIRST */}
              <form
                onSubmit={addItem}
                className="bg-neutral-950/40 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-4"
              >
                <div className="flex gap-2">
                  <input
                    value={form.title || ""}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="Title"
                    className="flex-1 rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
                  />
                </div>

                {autofillStatus ? <div className="text-xs text-neutral-400">{autofillStatus}</div> : null}

                {form.posterUrl ? (
                  <div className="flex items-center gap-3 rounded-2xl bg-neutral-950 border border-neutral-800 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={form.posterUrl} alt="Poster" className="w-12 h-16 rounded-lg object-cover bg-neutral-900" />
                    <div className="text-xs text-neutral-400">
                      Poster loaded • Tags: {(form.tags || []).slice(0, 4).join(", ") || "—"}
                    </div>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          posterUrl: "",
                          tags: f.tags ?? [],
                          tmdbId: undefined,
                          tmdbType: undefined,
                        }))
                      }
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      Remove poster
                    </button>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <Select
                    label="Type"
                    value={form.type || "movie"}
                    onChange={(v) => setForm({ ...form, type: v as MediaType, tmdbId: undefined, tmdbType: undefined })}
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
                      { value: "planned", label: "Watchlist / Plan to Watch" },
                      { value: "in_progress", label: "Watching" },
                      { value: "dropped", label: "Dropped" },
                    ]}
                  />

                  <NumInput
                    label="Rating (0–10)"
                    value={typeof form.rating === "number" ? form.rating : 0}
                    onChange={(n) =>
                      setForm((f) => ({
                        ...f,
                        rating: Number.isFinite(n) ? Math.max(0, Math.min(10, Number(n))) : undefined,
                      }))
                    }
                    min={0}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <NumInput
                    label="Progress current (optional)"
                    value={Number(form.progressCur ?? 0)}
                    onChange={(n) => setForm((f) => ({ ...f, progressCur: Math.max(0, Number(n ?? 0) || 0) }))}
                    min={0}
                  />
                  <NumInput
                    label="Progress total (optional)"
                    value={Number(form.progressTotal ?? 0)}
                    onChange={(n) => setForm((f) => ({ ...f, progressTotal: Math.max(0, Number(n ?? 0) || 0) }))}
                    min={0}
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

                  <Text
                    label="Poster image URL (optional)"
                    value={String(form.posterUrl || "")}
                    onChange={(v) => setForm({ ...form, posterUrl: v })}
                    helper="Paste any image URL, or auto-fill sets it for Movie/TV."
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Toggle label="In theaters" checked={!!form.inTheaters} onChange={(v) => setForm({ ...form, inTheaters: v })} />

                  <Toggle
                    label="Rewatch"
                    checked={isRewatch}
                    onChange={(v) => {
                      if (v) setForm((f) => ({ ...f, rewatchCount: Math.max(1, Number(f.rewatchCount ?? 1) || 1) }));
                      else setForm((f) => ({ ...f, rewatchCount: 0 }));
                    }}
                  />

                  <NumInput
                    label="Count"
                    value={Number(form.rewatchCount ?? 0)}
                    onChange={(n) => setForm((f) => ({ ...f, rewatchCount: Math.max(0, Number(n ?? 0) || 0) }))}
                    disabled={!isRewatch}
                    min={0}
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
                    <Toggle label="Auto-fill as you type (Movie/TV)" checked={autoAutofill} onChange={setAutoAutofill} />
                  </div>
                </div>
              </form>

              {/* PICK SECTION MOVED TO BOTTOM */}
              <div className="bg-neutral-950/40 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={pickForMe}
                    className="px-4 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
                  >
                    Pick something for me
                  </button>
                  <div className="text-xs text-neutral-400">{pickStatus}</div>
                </div>

                {picks.length ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                    {picks.map((p) => (
                      <button
                        key={`${p.tmdbType}:${p.tmdbId}`}
                        type="button"
                        onClick={() => {
                          // Force autofill to re-run for this title
                          lastAutofillKey.current = "";
                          setAutofillStatus("");
                          setForm((f) => ({
                            ...f,
                            title: p.title,
                            type: p.tmdbType,
                            tmdbId: undefined,
                            tmdbType: undefined,
                          }));
                        }}
                        className="text-left group"
                        title="Click to autofill this"
                      >
                        <div className="rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800 aspect-[2/3]">
                          {p.posterUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={p.posterUrl}
                              alt={p.title}
                              className="w-full h-full object-cover group-hover:scale-[1.02] transition"
                            />
                          ) : (
                            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">
                              No poster
                            </div>
                          )}
                        </div>
                        <div className="mt-2 text-[11px] text-neutral-200 line-clamp-2">{p.title}</div>
                        <div className="text-[10px] text-neutral-500">{p.tmdbType.toUpperCase()}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-neutral-500">
                    Click the button to generate poster picks based on your top-rated Movie/TV items.
                  </div>
                )}
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
                  <div className="hidden sm:grid grid-cols-[72px_1fr_90px_90px_120px] gap-3 px-3 py-2 rounded-xl bg-neutral-900/40 ring-1 ring-neutral-800/70 text-xs text-neutral-300">
                    <div />
                    <div>Title</div>
                    <div className="text-center">Score</div>
                    <div className="text-center">Type</div>
                    <div className="text-center">Progress</div>
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

        <input ref={fileInputRef} type="file" className="hidden" />
      </div>
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
    const map: Record<Status, MediaItem[]> = {
      completed: [],
      in_progress: [],
      planned: [],
      dropped: [],
    };
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
  const progressText =
    typeof item.progressCur === "number" || typeof item.progressTotal === "number"
      ? `${item.progressCur ?? 0} / ${item.progressTotal ?? "—"}`
      : "—";

  return (
    <div className="rounded-2xl bg-neutral-900/50 ring-1 ring-neutral-800/80 overflow-hidden">
      <div className="grid grid-cols-1 sm:grid-cols-[72px_1fr_90px_90px_120px] gap-3 p-3 items-center">
        <div className="w-[72px] h-[96px] rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800">
          {item.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.posterUrl} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold truncate">{item.title}</div>
              <div className="text-xs text-neutral-400 mt-1">
                Status:{" "}
                <select
                  value={item.status}
                  onChange={(e) => onUpdate({ status: e.target.value as Status })}
                  className="ml-1 rounded-md bg-neutral-950 border border-neutral-800 px-2 py-[2px] text-xs outline-none focus:border-neutral-500"
                >
                  <option value="completed">Completed</option>
                  <option value="in_progress">Watching</option>
                  <option value="planned">Watchlist</option>
                  <option value="dropped">Dropped</option>
                </select>
                {item.dateFinished ? <span className="ml-2 text-neutral-500">• {item.dateFinished}</span> : null}
              </div>

              {item.notes ? <div className="text-xs text-neutral-300 mt-2 line-clamp-2">{item.notes}</div> : null}
              {item.tags?.length ? (
                <div className="text-[11px] text-neutral-500 mt-1 truncate">{item.tags.join(" • ")}</div>
              ) : null}
            </div>

            <button
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 shrink-0"
              title="Delete"
            >
              Delete
            </button>
          </div>
        </div>

        <div className="text-center">
          <input
            type="number"
            min={0}
            max={10}
            value={item.rating ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") onUpdate({ rating: undefined });
              else onUpdate({ rating: Math.max(0, Math.min(10, Number(v))) });
            }}
            className="w-16 text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
            placeholder="—"
          />
        </div>

        <div className="text-center text-sm text-neutral-300">{item.type}</div>

        <div className="text-center">
          <div className="text-sm text-neutral-200">{progressText}</div>
          <div className="mt-1 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ progressCur: Math.max(0, (item.progressCur ?? 0) - 1) })}
              className="text-xs px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
            >
              -
            </button>
            <button
              type="button"
              onClick={() => onUpdate({ progressCur: (item.progressCur ?? 0) + 1 })}
              className="text-xs px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
            >
              +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= DRAG CARD ================= */

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

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;

  return (
    <article
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={[
        "bg-neutral-900/50 rounded-2xl overflow-hidden ring-1 ring-neutral-800/80 shadow-sm",
        "cursor-grab active:cursor-grabbing select-none",
        isDragging ? "opacity-70" : "",
      ].join(" ")}
    >
      <div className="flex gap-3 p-4">
        <div className="w-14 h-20 rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800 shrink-0">
          {item.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.posterUrl} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-500">No cover</div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate">{item.title}</div>

              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                <span>{item.type}</span>

                <select
                  value={item.status}
                  onChange={(e) => onUpdate({ status: e.target.value as Status })}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="rounded-md bg-neutral-950 border border-neutral-800 px-2 py-[1px] text-xs outline-none focus:border-neutral-500"
                >
                  <option value="completed">Completed</option>
                  <option value="in_progress">Watching</option>
                  <option value="planned">Watchlist</option>
                  <option value="dropped">Dropped</option>
                </select>

                {item.dateFinished ? `• ${item.dateFinished}` : ""}
                {typeof item.rating === "number" ? `• ★ ${item.rating.toFixed(1)}` : ""}
              </div>
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 shrink-0"
              title="Delete"
              onPointerDown={(e) => e.stopPropagation()}
            >
              Delete
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-neutral-500">Rating</span>
            <input
              type="number"
              min={0}
              max={10}
              value={item.rating ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") onUpdate({ rating: undefined });
                else onUpdate({ rating: Math.max(0, Math.min(10, Number(v))) });
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-16 rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
            />
            <span className="text-[11px] text-neutral-600">/ 10</span>
          </div>

          {item.notes ? <div className="text-xs text-neutral-300 line-clamp-2">{item.notes}</div> : null}
          {item.tags?.length ? <div className="text-[11px] text-neutral-500 truncate">{item.tags.join(" • ")}</div> : null}
        </div>
      </div>
    </article>
  );
}

/* ================= SMALL INPUT COMPONENTS ================= */

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
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

function Text({
  label,
  value,
  onChange,
  type = "text",
  helper,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  helper?: string;
}) {
  return (
    <label className="block">
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
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
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
      />
    </label>
  );
}

function NumInput({
  label,
  value,
  onChange,
  disabled,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  min?: number;
}) {
  return (
    <label className="block">
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        min={min}
        className={`w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500 ${
          disabled ? "opacity-50" : ""
        }`}
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
      <span className="text-sm text-neutral-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-6 w-11 items-center rounded-full border transition",
          checked ? "bg-emerald-500/20 border-emerald-500/30" : "bg-white/5 border-white/10",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block h-5 w-5 transform rounded-full transition",
            checked ? "translate-x-5 bg-emerald-200" : "translate-x-1 bg-neutral-200",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

/* ================= STATS UI HELPERS ================= */

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="bg-neutral-900/50 p-4 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
      <div className="text-xs text-neutral-400">{title}</div>
      <div className="text-3xl font-semibold mt-1">{value}</div>
      {sub ? <div className="text-xs text-neutral-500 mt-1">{sub}</div> : null}
    </div>
  );
}

function BarRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, total)) * 100)));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <div>{label}</div>
        <div>
          {value} <span className="text-neutral-600">({pct}%)</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-white/5 border border-white/10 overflow-hidden">
        <div className="h-full bg-white/15" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
