"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabaseClient";
import { DndContext, DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from "recharts";

/* ================= TYPES ================= */

type MediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
type Status = "planned" | "in_progress" | "dropped" | "completed";

type GroupMode = "none" | "day" | "month" | "year";
type SortMode = "newest" | "oldest" | "title" | "rating_high" | "rating_low";

export type StackView = "all" | "completed" | "watching" | "watchlist" | "dropped" | "stats" | "tags";

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;

  rating?: number; // 0-10
  posterUrl?: string;

  tmdbId?: number;
  tmdbType?: "movie" | "tv";

  inTheaters?: boolean;
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;

  rewatchCount?: number; // 0 = not a rewatch
  runtime?: number; // minutes

  // optional metadata
  platform?: string;
  withWhom?: string;
  format?: string;
  seasonOrChapter?: string;

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

function safeNum(n: unknown) {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function clampRating(v: number) {
  return Math.max(0, Math.min(10, v));
}

function fmtMinutes(mins: number) {
  const m = Math.max(0, Math.floor(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${r}m`;
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

  // multi-select + edit modal
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingItem = useMemo(() => items.find((i) => i.id === editingId) ?? null, [items, editingId]);

  // tags page state
  const [activeTag, setActiveTag] = useState<string>("");

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
    platform: "",
    withWhom: "",
    format: "",
    seasonOrChapter: "",
  });

  /* ================= NAV ================= */

  const nav = useMemo(
    () => [
      { href: "/", label: "All", key: "all" as StackView },
      { href: "/completed", label: "Completed", key: "completed" as StackView },
      { href: "/watching", label: "Watching", key: "watching" as StackView },
      { href: "/watchlist", label: "Watchlist", key: "watchlist" as StackView },
      { href: "/dropped", label: "Dropped", key: "dropped" as StackView },
      { href: "/stats", label: "Stats", key: "stats" as StackView },
      { href: "/tags", label: "Tags", key: "tags" as StackView },
    ],
    []
  );

  const pageMeta: Record<StackView, { title: string; subtitle: string }> = useMemo(
    () => ({
      all: { title: "All", subtitle: "Everything you’ve added to Stack" },
      completed: { title: "Completed", subtitle: "Finished media" },
      watching: { title: "Watching", subtitle: "In progress" },
      watchlist: { title: "Watchlist", subtitle: "Planned — for later" },
      dropped: { title: "Dropped", subtitle: "Paused or abandoned" },
      stats: { title: "Stats", subtitle: "Your breakdowns + charts" },
      tags: { title: "Tags", subtitle: "Explore your library by tag" },
    }),
    []
  );

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
    } else if (view === "tags") {
      setGroupMode("none");
      setSortMode("title");
      setBoardView(false);
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
        const ins = await supabase.from("media_items").insert({ user_id: uidStr, data: { items: [] } });
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
      typeof form.rating === "number" && Number.isFinite(form.rating) ? clampRating(form.rating) : undefined;

    const item: MediaItem = {
      id: uid(),
      title: String(form.title).trim(),
      type: form.type as MediaType,
      status,
      inTheaters: !!form.inTheaters,
      dateFinished: finalDate,
      posterUrl: (form.posterUrl || "").trim() || undefined,
      runtime: safeNum(form.runtime),
      notes: (form.notes || "").trim() || undefined,
      tags: (form.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
      rewatchCount: Math.max(0, Number(form.rewatchCount ?? 0) || 0),
      createdAt: new Date().toISOString(),
      rating,
      tmdbId: safeNum(form.tmdbId),
      tmdbType: form.tmdbType === "movie" || form.tmdbType === "tv" ? form.tmdbType : undefined,

      platform: (form.platform || "").trim() || undefined,
      withWhom: (form.withWhom || "").trim() || undefined,
      format: (form.format || "").trim() || undefined,
      seasonOrChapter: (form.seasonOrChapter || "").trim() || undefined,
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
      platform: "",
      withWhom: "",
      format: "",
      seasonOrChapter: "",
    }));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function updateItem(id: string, patch: Partial<MediaItem>) {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  function toggleExclude(t: MediaType) {
    setExcludeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelected() {
    setSelectedIds(new Set());
  }

  function bulkSetStatus(status: Status) {
    if (!selectedIds.size) return;
    setItems((prev) => prev.map((i) => (selectedIds.has(i.id) ? { ...i, status } : i)));
  }

  function bulkDelete() {
    if (!selectedIds.size) return;
    const ok = confirm(`Delete ${selectedIds.size} selected item(s)? This cannot be undone.`);
    if (!ok) return;
    setItems((prev) => prev.filter((i) => !selectedIds.has(i.id)));
    clearSelected();
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
      const all: string[] = [];

      for (const i of liked) {
        const type = i.tmdbType;
        const tmdbId = i.tmdbId;
        if (!type || !tmdbId) continue;

        const rec = await tmdbRecommendations(tmdbId, type);
        for (const r of rec.results ?? []) {
          const t = (r.title || r.name || "").trim();
          if (!t) continue;
          if (existingTitles.has(t.toLowerCase())) continue;
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

  /* ================= AUTO AUTOFILL ================= */

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

    if (view === "tags") {
      if (activeTag.trim()) out = out.filter((i) => (i.tags ?? []).some((t) => t.toLowerCase() === activeTag.toLowerCase()));
    }

    if (query) {
      const q = query.toLowerCase();
      out = out.filter((i) =>
        [i.title, i.notes, i.tags.join(" "), i.platform, i.withWhom, i.format, i.seasonOrChapter].some((v) =>
          String(v || "").toLowerCase().includes(q)
        )
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
  }, [items, view, query, sortMode, activeTag]);

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

  /* ================= PHASE 5 ANALYTICS ================= */

  const completedItems = useMemo(() => items.filter((i) => i.status === "completed" && !excludeTypes.has(i.type)), [items, excludeTypes]);

  const totalCompleted = completedItems.length;

  const totalMinutes = useMemo(() => completedItems.reduce((sum, i) => sum + (safeNum(i.runtime) ?? 0), 0), [completedItems]);

  const statusBreakdown = useMemo(() => {
    const map: Record<Status, number> = { planned: 0, in_progress: 0, dropped: 0, completed: 0 };
    for (const i of items) map[i.status] += 1;
    return (Object.entries(map) as Array<[Status, number]>).map(([k, v]) => ({ status: k, count: v }));
  }, [items]);

  const byTypeCompleted = useMemo(() => {
    const map = new Map<MediaType, { count: number; minutes: number }>();
    for (const i of completedItems) {
      const cur = map.get(i.type) ?? { count: 0, minutes: 0 };
      cur.count += 1;
      cur.minutes += safeNum(i.runtime) ?? 0;
      map.set(i.type, cur);
    }
    return Array.from(map.entries())
      .map(([type, v]) => ({ type, count: v.count, minutes: v.minutes }))
      .sort((a, b) => b.count - a.count);
  }, [completedItems]);

  const monthlyCompletions = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of completedItems) {
      const d = (i.dateFinished ?? i.createdAt).slice(0, 7); // YYYY-MM
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));
  }, [completedItems]);

  const ratingHistogram = useMemo(() => {
    // buckets: 0-1,1-2,...,9-10
    const buckets = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i}-${i + 1}`, count: 0 }));
    for (const i of completedItems) {
      if (typeof i.rating !== "number") continue;
      const r = clampRating(i.rating);
      const idx = Math.min(9, Math.max(0, Math.floor(r)));
      buckets[idx].count += 1;
    }
    return buckets;
  }, [completedItems]);

  const topTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) {
      for (const t of i.tags ?? []) {
        const tag = String(t).trim();
        if (!tag) continue;
        m.set(tag, (m.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(m.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);
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

        {/* ✅ STATS (PHASE 5) */}
        {view === "stats" ? (
          <div className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4">
              <StatCard title="Total completed" value={String(totalCompleted)} sub="Respects excluded types" />
              <StatCard title="Total time watched" value={fmtMinutes(totalMinutes)} sub="Sum of runtime minutes" />
              <StatCard title="Library size" value={String(items.length)} sub="All statuses" />
            </div>

            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="text-sm font-medium mb-2">Exclude types</div>
              <div className="flex flex-wrap gap-2">
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

            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard title="Completed by type">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={byTypeCompleted}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="type" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Status breakdown">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={statusBreakdown} dataKey="count" nameKey="status" outerRadius={100} label />
                    {/* no custom colors (keeps it simple + consistent with your constraints) */}
                    {statusBreakdown.map((_, idx) => (
                      <Cell key={idx} />
                    ))}
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard title="Completions over time">
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={monthlyCompletions}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Rating distribution (completed)">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={ratingHistogram}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="text-sm font-medium mb-2">Top tags</div>
              <div className="flex flex-wrap gap-2">
                {topTags.length ? (
                  topTags.map((t) => (
                    <span key={t.tag} className="px-3 py-1 rounded-xl bg-white/5 border border-white/10 text-xs">
                      {t.tag} <span className="text-neutral-500">({t.count})</span>
                    </span>
                  ))
                ) : (
                  <div className="text-xs text-neutral-400">No tags yet — add some via auto-fill or manually.</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* ✅ TAGS PAGE */}
        {view === "tags" ? (
          <div className="space-y-4">
            <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Browse by tag</div>
                  <div className="text-xs text-neutral-500">Click a tag to filter your library.</div>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    value={activeTag}
                    onChange={(e) => setActiveTag(e.target.value)}
                    placeholder="Type a tag…"
                    className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setActiveTag("")}
                    className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {topTags.length ? (
                  topTags.map((t) => (
                    <button
                      key={t.tag}
                      type="button"
                      onClick={() => setActiveTag(t.tag)}
                      className={`px-3 py-1 rounded-xl border text-xs ${
                        activeTag.toLowerCase() === t.tag.toLowerCase()
                          ? "bg-white/15 border-white/20"
                          : "bg-white/5 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {t.tag} <span className="text-neutral-500">({t.count})</span>
                    </button>
                  ))
                ) : (
                  <div className="text-xs text-neutral-400">No tags yet.</div>
                )}
              </div>
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search within tag results..."
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
            />

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((i) => (
                <MediaCard
                  key={i.id}
                  item={i}
                  selected={selectedIds.has(i.id)}
                  onToggleSelected={() => toggleSelected(i.id)}
                  onDelete={() => removeItem(i.id)}
                  onUpdate={(patch) => updateItem(i.id, patch)}
                  onEdit={() => setEditingId(i.id)}
                />
              ))}
            </div>

            {!filtered.length ? (
              <div className="text-sm text-neutral-500 text-center py-10">
                No results for <span className="text-neutral-200">{activeTag || "that tag"}</span>.
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ✅ MAIN APP (non-stats, non-tags) */}
        {view !== "stats" && view !== "tags" ? (
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
                  onChange={(n) => setForm((f) => ({ ...f, rating: clampRating(Number(n) || 0) }))}
                  min={0}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Text
                  label="Date watched (optional)"
                  type="date"
                  value={String(form.dateFinished || "")}
                  onChange={(v) => setForm({ ...form, dateFinished: v })}
                />

                <NumInput
                  label="Runtime (minutes)"
                  value={Number(form.runtime ?? 0)}
                  onChange={(n) => setForm((f) => ({ ...f, runtime: Math.max(0, Number(n) || 0) }))}
                  min={0}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Text label="Platform (optional)" value={String(form.platform || "")} onChange={(v) => setForm({ ...form, platform: v })} />
                <Text label="With whom (optional)" value={String(form.withWhom || "")} onChange={(v) => setForm({ ...form, withWhom: v })} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Text label="Format (optional)" value={String(form.format || "")} onChange={(v) => setForm({ ...form, format: v })} />
                <Text
                  label="Season / Chapter (optional)"
                  value={String(form.seasonOrChapter || "")}
                  onChange={(v) => setForm({ ...form, seasonOrChapter: v })}
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
                placeholder="Search title, notes, tags, platform..."
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
                <BoardView
                  items={filtered}
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                  onDelete={removeItem}
                  onUpdate={updateItem}
                  onEdit={(id) => setEditingId(id)}
                />
              ) : groupMode !== "none" && grouped ? (
                <div className="space-y-6">
                  {grouped.map(([k, list]) => (
                    <section key={k} className="space-y-2">
                      <h3 className="text-sm text-neutral-400">{k}</h3>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {list.map((i) => (
                          <MediaCard
                            key={i.id}
                            item={i}
                            selected={selectedIds.has(i.id)}
                            onToggleSelected={() => toggleSelected(i.id)}
                            onDelete={() => removeItem(i.id)}
                            onUpdate={(patch) => updateItem(i.id, patch)}
                            onEdit={() => setEditingId(i.id)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filtered.map((i) => (
                    <MediaCard
                      key={i.id}
                      item={i}
                      selected={selectedIds.has(i.id)}
                      onToggleSelected={() => toggleSelected(i.id)}
                      onDelete={() => removeItem(i.id)}
                      onUpdate={(patch) => updateItem(i.id, patch)}
                      onEdit={() => setEditingId(i.id)}
                    />
                  ))}
                </div>
              )}
            </DndContext>
          </>
        ) : null}

        <footer className="pt-6 text-xs text-neutral-500">Stack • Saves to Supabase + local backup</footer>

        {editingItem ? (
          <EditModal
            item={editingItem}
            onClose={() => setEditingId(null)}
            onSave={(patch) => {
              updateItem(editingItem.id, patch);
              setEditingId(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ================= SMALL UI PIECES ================= */

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-3xl font-semibold mt-1">{value}</div>
      {sub ? <div className="text-xs text-neutral-500 mt-2">{sub}</div> : null}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm">
      <div className="text-sm font-medium mb-3">{title}</div>
      {children}
    </div>
  );
}

/* ================= BOARD VIEW ================= */

function BoardView({
  items,
  selectedIds,
  onToggleSelected,
  onDelete,
  onUpdate,
  onEdit,
}: {
  items: MediaItem[];
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<MediaItem>) => void;
  onEdit: (id: string) => void;
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
              <MediaCard
                key={i.id}
                item={i}
                selected={selectedIds.has(i.id)}
                onToggleSelected={() => onToggleSelected(i.id)}
                onDelete={() => onDelete(i.id)}
                onUpdate={(patch) => onUpdate(i.id, patch)}
                onEdit={() => onEdit(i.id)}
              />
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

/* ================= EDIT MODAL ================= */

function EditModal({
  item,
  onClose,
  onSave,
}: {
  item: MediaItem;
  onClose: () => void;
  onSave: (patch: Partial<MediaItem>) => void;
}) {
  const [draft, setDraft] = useState<MediaItem>(item);

  useEffect(() => setDraft(item), [item]);

  function save() {
    const patch: Partial<MediaItem> = {
      title: draft.title.trim(),
      type: draft.type,
      status: draft.status,
      rating: typeof draft.rating === "number" ? clampRating(draft.rating) : undefined,
      dateFinished: draft.dateFinished?.trim() || undefined,
      runtime: draft.runtime == null ? undefined : Math.max(0, Math.floor(draft.runtime)),
      rewatchCount: Math.max(0, Math.floor(draft.rewatchCount ?? 0)),
      tags: (draft.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
      notes: draft.notes?.trim() || undefined,
      posterUrl: draft.posterUrl?.trim() || undefined,
      inTheaters: !!draft.inTheaters,
      platform: draft.platform?.trim() || undefined,
      withWhom: draft.withWhom?.trim() || undefined,
      format: draft.format?.trim() || undefined,
      seasonOrChapter: draft.seasonOrChapter?.trim() || undefined,
    };
    onSave(patch);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-2xl bg-neutral-950 border border-neutral-800 p-4 sm:p-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Edit item</div>
            <div className="text-xs text-neutral-500">Click outside to close.</div>
          </div>
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm">
            Close
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Text label="Title" value={draft.title} onChange={(v) => setDraft((d) => ({ ...d, title: v }))} />
          <Select
            label="Type"
            value={draft.type}
            onChange={(v) => setDraft((d) => ({ ...d, type: v as MediaType }))}
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
            value={draft.status}
            onChange={(v) => setDraft((d) => ({ ...d, status: v as Status }))}
            options={[
              { value: "completed", label: "Completed" },
              { value: "planned", label: "Watchlist" },
              { value: "in_progress", label: "Watching" },
              { value: "dropped", label: "Dropped" },
            ]}
          />

          <NumInput label="Rating (0–10)" value={Number(draft.rating ?? 0)} onChange={(n) => setDraft((d) => ({ ...d, rating: clampRating(Number(n) || 0) }))} min={0} />
          <Text label="Date finished" type="date" value={draft.dateFinished ?? ""} onChange={(v) => setDraft((d) => ({ ...d, dateFinished: v }))} />
          <NumInput label="Runtime (minutes)" value={Number(draft.runtime ?? 0)} onChange={(n) => setDraft((d) => ({ ...d, runtime: Math.max(0, Number(n) || 0) }))} min={0} />
          <NumInput label="Rewatch count" value={Number(draft.rewatchCount ?? 0)} onChange={(n) => setDraft((d) => ({ ...d, rewatchCount: Math.max(0, Number(n) || 0) }))} min={0} />

          <Toggle label="In theaters" checked={!!draft.inTheaters} onChange={(v) => setDraft((d) => ({ ...d, inTheaters: v }))} />
          <Text label="Platform" value={draft.platform ?? ""} onChange={(v) => setDraft((d) => ({ ...d, platform: v }))} />
          <Text label="With whom" value={draft.withWhom ?? ""} onChange={(v) => setDraft((d) => ({ ...d, withWhom: v }))} />
          <Text label="Format" value={draft.format ?? ""} onChange={(v) => setDraft((d) => ({ ...d, format: v }))} />
          <Text label="Season / Chapter" value={draft.seasonOrChapter ?? ""} onChange={(v) => setDraft((d) => ({ ...d, seasonOrChapter: v }))} />
        </div>

        <div className="mt-3">
          <Text label="Poster URL" value={draft.posterUrl ?? ""} onChange={(v) => setDraft((d) => ({ ...d, posterUrl: v }))} />
        </div>

        <div className="mt-3">
          <Text
            label="Tags (comma separated)"
            value={(draft.tags ?? []).join(", ")}
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                tags: v.split(",").map((x) => x.trim()).filter(Boolean),
              }))
            }
          />
        </div>

        <div className="mt-3">
          <TextArea label="Notes" value={draft.notes ?? ""} onChange={(v) => setDraft((d) => ({ ...d, notes: v }))} />
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={save} className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25 text-sm">
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= CARD ================= */

function MediaCard({
  item,
  selected,
  onToggleSelected,
  onDelete,
  onUpdate,
  onEdit,
}: {
  item: MediaItem;
  selected: boolean;
  onToggleSelected: () => void;
  onDelete: () => void;
  onUpdate: (patch: Partial<MediaItem>) => void;
  onEdit: () => void;
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
        "bg-neutral-900/50 rounded-2xl overflow-hidden ring-1 shadow-sm",
        selected ? "ring-emerald-500/40" : "ring-neutral-800/80",
        "cursor-grab active:cursor-grabbing select-none",
        isDragging ? "opacity-70" : "",
      ].join(" ")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
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
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelected();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`w-5 h-5 rounded-md border ${
                    selected ? "bg-emerald-500/20 border-emerald-500/30" : "bg-neutral-950 border-neutral-800"
                  }`}
                  title="Select"
                />
                <div className="font-medium truncate">{item.title}</div>
              </div>

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
                {(item.rewatchCount ?? 0) > 0 ? `• rewatch x${item.rewatchCount}` : ""}
                {typeof item.rating === "number" ? `• ★ ${item.rating.toFixed(1)}` : ""}
                {typeof item.runtime === "number" ? `• ${fmtMinutes(item.runtime)}` : ""}
              </div>
            </div>

            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="text-xs px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
                title="Edit"
              >
                Edit
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
                title="Delete"
                onPointerDown={(e) => e.stopPropagation()}
              >
                Delete
              </button>
            </div>
          </div>

          {item.platform ? <div className="text-[11px] text-neutral-500">Platform: {item.platform}</div> : null}
          {item.withWhom ? <div className="text-[11px] text-neutral-500">With: {item.withWhom}</div> : null}
          {item.notes ? <div className="text-xs text-neutral-300 line-clamp-2">{item.notes}</div> : null}
          {item.tags?.length ? <div className="text-[11px] text-neutral-500 truncate">{item.tags.join(" • ")}</div> : null}
        </div>
      </div>
    </article>
  );
}

/* ================= UI COMPONENTS ================= */

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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
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
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <label className="block">
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
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
