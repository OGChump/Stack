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

export type StackView = "all" | "completed" | "watching" | "watchlist" | "dropped" | "stats";

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;

  rating?: number; // 0-10
  posterUrl?: string;

  // For "Pick something for me" (only for Movie/TV)
  tmdbId?: number;
  tmdbType?: "movie" | "tv";

  inTheaters?: boolean;
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;
  rewatchCount?: number; // 0 = not a rewatch, >=1 = rewatch count
  runtime?: number; // minutes
  status: Status;
  tags: string[];
  createdAt: string; // ISO
};

type TmdbSearchResult = {
  results?: Array<{ id: number; title?: string; name?: string }>;
};

type TmdbGenre = { name: string };

type TmdbDetailsResult = {
  poster_path?: string | null;
  runtime?: number | null;
  episode_run_time?: number[] | null;
  genres?: TmdbGenre[] | null;
};

type TmdbRecommendationsResult = {
  results?: Array<{ id: number; title?: string; name?: string }>;
};

const LOCAL_BACKUP_KEY = "stack-items-backup-v1";

const STATUSES: Array<{ id: Status; label: string }> = [
  { id: "completed", label: "Completed" },
  { id: "in_progress", label: "Watching" },
  { id: "planned", label: "Watchlist" },
  { id: "dropped", label: "Dropped" },
];

const ALL_TYPES: MediaType[] = ["movie", "tv", "anime", "manga", "book", "game"];

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function toGroupKey(mode: GroupMode, dateStr?: string) {
  if (!dateStr) return "Undated";
  if (mode === "day") return dateStr.slice(0, 10); // YYYY-MM-DD
  if (mode === "month") return dateStr.slice(0, 7); // YYYY-MM
  if (mode === "year") return dateStr.slice(0, 4); // YYYY
  return "All";
}

function safeLower(s: string) {
  return (s || "").trim().toLowerCase();
}

function formatMinutesToHours(mins: number) {
  if (!Number.isFinite(mins) || mins <= 0) return "0h";
  const hours = mins / 60;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
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

  const [groupMode, setGroupMode] = useState<GroupMode>("month");
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const [boardView, setBoardView] = useState(true);

  const [autofillStatus, setAutofillStatus] = useState("");
  const [autoAutofill, setAutoAutofill] = useState(true);
  const autofillTimer = useRef<number | null>(null);
  const lastAutofillKey = useRef<string>("");

  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  const [picks, setPicks] = useState<string[]>([]);
  const [pickStatus, setPickStatus] = useState("");

  const [excludeTypes, setExcludeTypes] = useState<Set<MediaType>>(new Set());

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
    runtime: undefined,
  });

  /* ================= NAV + PAGE META ================= */

  const nav = useMemo(
    () => [
      { href: "/", label: "All", key: "all" as StackView },
      { href: "/completed", label: "Completed", key: "completed" as StackView },
      { href: "/watching", label: "Watching", key: "watching" as StackView },
      { href: "/watchlist", label: "Watchlist", key: "watchlist" as StackView },
      { href: "/dropped", label: "Dropped", key: "dropped" as StackView },
      { href: "/stats", label: "Stats", key: "stats" as StackView },
    ],
    []
  );

  const pageMeta: Record<StackView, { title: string; subtitle: string }> = useMemo(
    () => ({
      all: { title: "All", subtitle: "Everything you’ve added to Stack" },
      completed: { title: "Completed", subtitle: "Finished movies, shows, games, and more" },
      watching: { title: "Watching", subtitle: "Currently in progress" },
      watchlist: { title: "Watchlist", subtitle: "Planned — for later" },
      dropped: { title: "Dropped", subtitle: "Paused or abandoned" },
      stats: { title: "Stats", subtitle: "Your totals, time, and breakdowns" },
    }),
    []
  );

  // Phase 2 defaults per page
  useEffect(() => {
    if (view === "watchlist") {
      setGroupMode("none");
      setSortMode("title");
      setBoardView(false);
    } else if (view === "completed") {
      setGroupMode("month");
      setSortMode("newest");
      setBoardView(false);
    } else if (view === "watching") {
      setGroupMode("none");
      setSortMode("newest");
      setBoardView(false);
    } else if (view === "dropped") {
      setGroupMode("none");
      setSortMode("newest");
      setBoardView(false);
    } else if (view === "all") {
      setGroupMode("month");
      setSortMode("newest");
      setBoardView(true);
    }
  }, [view]);

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
      tags: (form.tags ?? []).map((t) => t.trim()).filter(Boolean),
      rewatchCount: Math.max(0, Number(form.rewatchCount ?? 0) || 0),
      createdAt: new Date().toISOString(),

      rating,
      tmdbId: typeof form.tmdbId === "number" ? form.tmdbId : undefined,
      tmdbType: form.tmdbType === "movie" || form.tmdbType === "tv" ? form.tmdbType : undefined,
    };

    setItems((p) => [item, ...p]);

    setAutofillStatus("");
    setForm({
      title: "",
      type: form.type ?? "movie",
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
    });
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

      const existingTitles = new Set(items.map((i) => safeLower(i.title)));
      const all: string[] = [];

      for (const i of liked) {
        const type = i.tmdbType;
        const tmdbId = i.tmdbId;
        if (!type || !tmdbId) continue;

        const rec = await tmdbRecommendations(tmdbId, type);
        for (const r of rec.results ?? []) {
          const t = (r.title || r.name || "").trim();
          if (!t) continue;
          if (existingTitles.has(safeLower(t))) continue;
          all.push(t);
        }
      }

      const unique = Array.from(new Set(all)).slice(0, 5);
      setPicks(unique);
      setPickStatus(unique.length ? "Here you go." : "No new picks found (try rating more items).");
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

  /* ================= PHASE 3: STATS ================= */

  const countsByStatus = useMemo(() => {
    const base: Record<Status, number> = { completed: 0, in_progress: 0, planned: 0, dropped: 0 };
    for (const i of items) base[i.status] += 1;
    return base;
  }, [items]);

  const countsByType = useMemo(() => {
    const base: Record<MediaType, number> = {
      movie: 0,
      tv: 0,
      anime: 0,
      manga: 0,
      book: 0,
      game: 0,
    };
    for (const i of items) base[i.type] += 1;
    return base;
  }, [items]);

  const completedItems = useMemo(() => {
    return items.filter((i) => i.status === "completed");
  }, [items]);

  const completedTimeMinutes = useMemo(() => {
    // Only count runtime when present
    let mins = 0;
    for (const i of completedItems) {
      if (excludeTypes.has(i.type)) continue;
      if (typeof i.runtime === "number" && Number.isFinite(i.runtime) && i.runtime > 0) mins += i.runtime;
    }
    return mins;
  }, [completedItems, excludeTypes]);

  const avgRuntimeCompleted = useMemo(() => {
    const runtimes: number[] = [];
    for (const i of completedItems) {
      if (excludeTypes.has(i.type)) continue;
      if (typeof i.runtime === "number" && Number.isFinite(i.runtime) && i.runtime > 0) runtimes.push(i.runtime);
    }
    if (!runtimes.length) return 0;
    return runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
  }, [completedItems, excludeTypes]);

  const avgByType = useMemo(() => {
    const map = new Map<MediaType, { sum: number; count: number }>();
    for (const i of items) {
      if (typeof i.rating !== "number") continue;
      const cur = map.get(i.type) ?? { sum: 0, count: 0 };
      cur.sum += i.rating;
      cur.count += 1;
      map.set(i.type, cur);
    }
    return Array.from(map.entries()).map(([type, v]) => ({
      type,
      avg: v.count ? v.sum / v.count : 0,
      count: v.count,
    }));
  }, [items]);

  const topTags = useMemo(() => {
    // Tags = your genres / manual tags
    const freq = new Map<string, number>();
    for (const i of items) {
      for (const raw of i.tags ?? []) {
        const t = raw.trim();
        if (!t) continue;
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count }));
  }, [items]);

  const recentCompleted = useMemo(() => {
    const out = completedItems.slice();
    out.sort((a, b) => {
      const ad = new Date((a.dateFinished ?? a.createdAt) as string).getTime();
      const bd = new Date((b.dateFinished ?? b.createdAt) as string).getTime();
      return bd - ad;
    });
    return out.slice(0, 10);
  }, [completedItems]);

  const totalCompleted = useMemo(() => {
    return completedItems.filter((i) => !excludeTypes.has(i.type)).length;
  }, [completedItems, excludeTypes]);

  const totalRewatches = useMemo(() => {
    let total = 0;
    for (const i of items) total += Math.max(0, Number(i.rewatchCount ?? 0) || 0);
    return total;
  }, [items]);

  /* ================= UI ================= */

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Stack</h1>
              <p className="text-sm text-neutral-400">
                {pageMeta[view].title} • {pageMeta[view].subtitle}
              </p>
            </div>
            <div className="text-xs text-neutral-500">{saveStatus}</div>
          </div>

          <nav className="flex flex-wrap gap-2">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-2 rounded-xl border text-sm ${
                  view === n.key ? "bg-white/15 border-white/20" : "bg-white/5 border-white/10 hover:bg-white/10"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </header>

        {/* ================= STATS PAGE (PHASE 3) ================= */}
        {view === "stats" ? (
          <div className="space-y-4">
            {/* Top numbers */}
            <div className="grid md:grid-cols-4 gap-4">
              <StatCard title="Total items" value={String(items.length)} sub="Everything in your Stack" />
              <StatCard title="Completed" value={String(totalCompleted)} sub="Excludes selected types below" />
              <StatCard title="Total time (completed)" value={formatMinutesToHours(completedTimeMinutes)} sub="Counts runtime when available" />
              <StatCard title="Rewatches" value={String(totalRewatches)} sub="Sum of rewatch counts" />
            </div>

            {/* Exclude types for time/completed */}
            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Exclude types from “Completed” + “Time”</div>
                  <div className="text-xs text-neutral-400 mt-1">
                    Useful if you don’t want books/manga counting toward your completion totals.
                  </div>
                </div>
                <div className="text-xs text-neutral-400">
                  Avg runtime (completed):{" "}
                  <span className="text-neutral-200">{avgRuntimeCompleted ? `${Math.round(avgRuntimeCompleted)}m` : "—"}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mt-3">
                {ALL_TYPES.map((t) => (
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

            {/* Status breakdown */}
            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="text-sm font-medium mb-3">By status</div>
              <div className="grid sm:grid-cols-4 gap-3">
                {STATUSES.map((s) => (
                  <MiniCard key={s.id} title={s.label} value={String(countsByStatus[s.id])} />
                ))}
              </div>
            </div>

            {/* Type breakdown + ratings */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">By type</div>
                <div className="space-y-2">
                  {ALL_TYPES.map((t) => {
                    const count = countsByType[t];
                    const pct = items.length ? Math.round((count / items.length) * 100) : 0;
                    return (
                      <div key={t} className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
                        <div className="flex items-center justify-between text-sm">
                          <div className="text-neutral-200 capitalize">{t}</div>
                          <div className="text-neutral-400">
                            {count} <span className="text-neutral-600">({pct}%)</span>
                          </div>
                        </div>
                        <div className="mt-2 h-2 rounded-full bg-neutral-900 overflow-hidden">
                          <div
                            className="h-full bg-white/30"
                            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
                <div className="text-sm font-medium mb-3">Average rating</div>
                <div className="grid sm:grid-cols-2 gap-2 text-sm text-neutral-300">
                  {avgByType.length ? (
                    avgByType.map((x) => (
                      <div key={x.type} className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2">
                        <div className="text-xs text-neutral-400">{x.type}</div>
                        <div>
                          {x.avg.toFixed(1)}{" "}
                          <span className="text-xs text-neutral-500">({x.count} rated)</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-neutral-400">Rate some items to see averages.</div>
                  )}
                </div>
              </div>
            </div>

            {/* Tags */}
            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="text-sm font-medium mb-2">Top tags / genres</div>
              {topTags.length ? (
                <div className="flex flex-wrap gap-2">
                  {topTags.map((t) => (
                    <span
                      key={t.tag}
                      className="text-xs px-3 py-1 rounded-xl bg-white/5 border border-white/10"
                      title={`${t.count} items`}
                    >
                      {t.tag} <span className="text-neutral-500">({t.count})</span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-neutral-400">No tags yet. Auto-fill Movie/TV to generate genres.</div>
              )}
            </div>

            {/* Recently completed */}
            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="text-sm font-medium mb-2">Recently completed</div>
              {recentCompleted.length ? (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {recentCompleted.map((i) => (
                    <div key={i.id} className="rounded-xl bg-neutral-950 border border-neutral-800 p-3">
                      <div className="text-sm font-medium truncate">{i.title}</div>
                      <div className="text-xs text-neutral-400 mt-1">
                        {i.type}
                        {i.dateFinished ? ` • ${i.dateFinished}` : ""}
                        {typeof i.rating === "number" ? ` • ★ ${i.rating.toFixed(1)}` : ""}
                        {typeof i.runtime === "number" ? ` • ${i.runtime}m` : ""}
                      </div>
                      {i.tags?.length ? (
                        <div className="text-[11px] text-neutral-500 mt-2 truncate">{i.tags.join(" • ")}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-neutral-400">Nothing completed yet.</div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Recommender */}
            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-3">
              <div className="flex items-center gap-3">
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
                <ul className="text-sm text-neutral-200 list-disc pl-5 space-y-1">
                  {picks.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* Add */}
            <form
              onSubmit={addItem}
              className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-4"
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
                    {typeof form.runtime === "number" ? ` • ${form.runtime}m` : ""}
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
                        runtime: undefined,
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
                    { value: "planned", label: "Watchlist" },
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
                  helper="Paste any image URL, or auto-fill will set it for Movie/TV."
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

            {/* Search + view controls */}
            <section className="space-y-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, notes, tags..."
                className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
              />

              {view === "all" ? (
                <div className="flex items-center justify-between">
                  <div className="text-xs text-neutral-500">Board view lets you drag cards between statuses.</div>
                  <Toggle label="Board view" checked={boardView} onChange={setBoardView} />
                </div>
              ) : null}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Select
                  label="Group"
                  value={groupMode}
                  onChange={(v) => setGroupMode(v as GroupMode)}
                  options={[
                    { value: "none", label: "No grouping" },
                    { value: "day", label: "By day" },
                    { value: "month", label: "By month" },
                    { value: "year", label: "By year" },
                  ]}
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
            </section>

            {/* List / Board */}
            <DndContext onDragEnd={handleDragEnd}>
              {view === "all" && boardView ? (
                <BoardView items={filtered} onDelete={removeItem} onUpdate={updateItem} />
              ) : groupMode !== "none" && grouped ? (
                <div className="space-y-6">
                  {grouped.map(([k, list]) => (
                    <section key={k} className="space-y-2">
                      <h3 className="text-sm text-neutral-400">{k}</h3>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {list.map((i) => (
                          <MediaCard key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={(patch) => updateItem(i.id, patch)} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filtered.map((i) => (
                    <MediaCard key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={(patch) => updateItem(i.id, patch)} />
                  ))}
                </div>
              )}
            </DndContext>
          </>
        )}

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
              <MediaCard key={i.id} item={i} onDelete={() => onDelete(i.id)} onUpdate={(patch) => onUpdate(i.id, patch)} />
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

/* ================= CARDS + UI ================= */

function MediaCard({
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

                {item.inTheaters ? "• in theaters" : ""}
                {item.dateFinished ? `• ${item.dateFinished}` : ""}
                {(item.rewatchCount ?? 0) > 0 ? `• rewatch x${item.rewatchCount}` : ""}
                {typeof item.runtime === "number" ? `• ${item.runtime}m` : ""}
                {typeof item.rating === "number" ? `• ★ ${item.rating.toFixed(1)}` : ""}
              </div>
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 shrink-0"
              title="Delete"
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
    <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
      <div className="text-xs text-neutral-400">{title}</div>
      <div className="text-3xl font-semibold mt-1">{value}</div>
      {sub ? <div className="text-xs text-neutral-500 mt-2">{sub}</div> : null}
    </div>
  );
}

function MiniCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl bg-neutral-950 border border-neutral-800 p-4">
      <div className="text-xs text-neutral-500">{title}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
