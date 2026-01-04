"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthGate from "../components/AuthGate";
import { supabase } from "../lib/supabaseClient";

import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

/* ================= TYPES ================= */

type MediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
type Status = "planned" | "in_progress" | "dropped" | "completed";

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;
  rating?: number; // 0–10
  inTheaters?: boolean;
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;
  rewatchCount?: number; // 0 = not a rewatch, >=1 = rewatch count
  format?: string;
  seasonOrChapter?: string;
  platform?: string;
  withWhom?: string;
  posterUrl?: string;
  runtime?: number;
  status: Status;
  tags: string[];
  year?: number;
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

const LOCAL_BACKUP_KEY = "stack-items-backup-v1";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function toMonthKey(dateStr?: string) {
  if (!dateStr) return "Undated";
  return dateStr.slice(0, 7); // YYYY-MM
}

function clampRating(v: number) {
  if (!Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(10, v));
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

/* ================= PAGE ================= */

export default function Page() {
  return (
    <AuthGate>
      <StackApp />
    </AuthGate>
  );
}

function StackApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "completed" | "watching" | "watchlist" | "dropped">("all");

  const [groupByMonth, setGroupByMonth] = useState(true);
  const [autofillStatus, setAutofillStatus] = useState("");

  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  // Default status "completed"
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
  });

  const isRewatch = (form.rewatchCount ?? 0) > 0;

  /* ================= DND ================= */

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function parseDragId(raw: string): { kind: "item"; id: string } | null {
    if (!raw.startsWith("item:")) return null;
    return { kind: "item", id: raw.slice("item:".length) };
  }

  function parseDropId(raw: string): { kind: "column"; status: Status } | null {
    if (!raw.startsWith("col:")) return null;
    const s = raw.slice("col:".length) as Status;
    if (s === "completed" || s === "planned" || s === "in_progress" || s === "dropped") {
      return { kind: "column", status: s };
    }
    return null;
  }

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const activeId = String(e.active.id);
      const overId = e.over?.id ? String(e.over.id) : null;
      if (!overId) return;

      const a = parseDragId(activeId);
      const o = parseDropId(overId);
      if (!a || !o) return;

      setItems((prev) => {
        const idx = prev.findIndex((x) => x.id === a.id);
        if (idx === -1) return prev;

        const next = prev.slice();
        const curr = next[idx];

        if (curr.status === o.status) return prev;

        // If moving to completed, auto-set date if missing
        let nextDateFinished = curr.dateFinished;
        if (o.status === "completed" && !nextDateFinished) nextDateFinished = todayYMD();
        // If moving out of completed, keep dateFinished as-is (so your history stays)

        next[idx] = { ...curr, status: o.status, dateFinished: nextDateFinished };
        return next;
      });
    },
    [setItems]
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
    async (uid: string) => {
      setSaveStatus("Loading…");
      setCloudLoaded(false);

      const { data, error } = await supabase.from("media_items").select("data").eq("user_id", uid).maybeSingle();

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
        const ins = await supabase.from("media_items").insert({ user_id: uid, data: { items: [] } });

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
    async (uid: string, next: MediaItem[]) => {
      saveLocalBackup(next);
      if (!cloudLoaded) return;

      setSaveStatus("Saving…");

      const { error } = await supabase
        .from("media_items")
        .upsert({ user_id: uid, data: { items: next } }, { onConflict: "user_id" });

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

    // Always reset tab to All on load/refresh
    setTab("all");
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
    if (userId) void saveCloud(userId, items);
    else saveLocalBackup(items);
  }, [items, userId, cloudLoaded, saveCloud, saveLocalBackup]);

  /* ================= HELPERS ================= */

  const updateItem = useCallback((id: string, patch: Partial<MediaItem>) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  /* ================= ACTIONS ================= */

  function addItem(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!form.title) return;

    const status = (form.status as Status) ?? "completed";

    const manualDate = (form.dateFinished || "").trim();
    const autoDate = status === "completed" ? todayYMD() : "";
    const finalDate = manualDate || autoDate || undefined;

    const rating = typeof form.rating === "number" ? clampRating(form.rating) : undefined;

    const item: MediaItem = {
      id: uid(),
      title: String(form.title).trim(),
      type: form.type as MediaType,
      status,
      inTheaters: !!form.inTheaters,
      dateFinished: finalDate,
      posterUrl: form.posterUrl,
      runtime: typeof form.runtime === "number" ? form.runtime : undefined,
      notes: (form.notes || "").trim() || undefined,
      tags: form.tags ?? [],
      rewatchCount: Math.max(0, Number(form.rewatchCount ?? 0) || 0),
      rating,
      createdAt: new Date().toISOString(),
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
    });
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function autofill() {
    const title = (form.title || "").trim();

    if (!title) {
      setAutofillStatus("Type a title first.");
      return;
    }

    if (form.type !== "movie" && form.type !== "tv") {
      setAutofillStatus("Auto-fill only works for Movie or TV (TMDB).");
      return;
    }

    try {
      setAutofillStatus("Searching TMDB…");

      const s = await tmdbSearch(title, form.type);
      const hit = s?.results?.[0];

      if (!hit) {
        setAutofillStatus("No match found on TMDB.");
        return;
      }

      setAutofillStatus(`Found: ${hit.title || hit.name || "Match"}`);

      const d = await tmdbDetails(hit.id, form.type);

      setForm((f) => ({
        ...f,
        posterUrl: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : f.posterUrl,
        runtime: d.runtime ?? d.episode_run_time?.[0] ?? f.runtime,
        tags: (d.genres ?? []).map((g) => g.name),
      }));

      setAutofillStatus("Auto-fill complete.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setAutofillStatus(`TMDB error: ${msg}`);
    }
  }

  /* ================= FILTER ================= */

  const filtered = useMemo(() => {
    let out = items.slice();

    if (tab === "completed") out = out.filter((i) => i.status === "completed");
    if (tab === "watching") out = out.filter((i) => i.status === "in_progress");
    if (tab === "watchlist") out = out.filter((i) => i.status === "planned");
    if (tab === "dropped") out = out.filter((i) => i.status === "dropped");

    if (query) {
      const q = query.toLowerCase();
      out = out.filter((i) =>
        [i.title, i.notes, i.tags.join(" ")].some((v) => String(v || "").toLowerCase().includes(q))
      );
    }

    out.sort((a, b) => {
      const ad = new Date((a.dateFinished ?? a.createdAt) as string).getTime();
      const bd = new Date((b.dateFinished ?? b.createdAt) as string).getTime();
      return bd - ad;
    });

    return out;
  }, [items, tab, query]);

  const grouped = useMemo(() => {
    if (!groupByMonth) return null;

    const map = new Map<string, MediaItem[]>();
    for (const i of filtered) {
      const k = toMonthKey(i.dateFinished ?? i.createdAt);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(i);
    }

    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered, groupByMonth]);

  /* ================= BOARD (All tab) ================= */

  const board = useMemo(() => {
    const all = filtered; // filtered already includes search query
    const planned = all.filter((x) => x.status === "planned");
    const inProg = all.filter((x) => x.status === "in_progress");
    const completed = all.filter((x) => x.status === "completed");
    const dropped = all.filter((x) => x.status === "dropped");
    return { planned, inProg, completed, dropped };
  }, [filtered]);

  /* ================= UI ================= */

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="space-y-1">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Stack</h1>
              <p className="text-sm text-neutral-400">Your personal media stack</p>
            </div>
            <div className="text-xs text-neutral-500">{saveStatus}</div>
          </div>
        </header>

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
            <button
              type="button"
              onClick={autofill}
              className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
            >
              Auto-fill
            </button>
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
                onClick={() => setForm((f) => ({ ...f, posterUrl: "", tags: f.tags ?? [] }))}
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
              onChange={(v) => setForm({ ...form, type: v as MediaType })}
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
              onChange={(n) => setForm((f) => ({ ...f, rating: clampRating(n) }))}
              min={0}
              max={10}
              step={0.5}
              allowEmpty
            />

            {/* one line row: in theaters + rewatch + count */}
            <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Toggle
                label="In theaters"
                checked={!!form.inTheaters}
                onChange={(v) => setForm({ ...form, inTheaters: v })}
              />

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
                onChange={(n) => setForm((f) => ({ ...f, rewatchCount: Math.max(0, Number(n) || 0) }))}
                disabled={!isRewatch}
                min={0}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Text
              label="Date watched (optional)"
              type="date"
              value={String(form.dateFinished || "")}
              onChange={(v) => setForm({ ...form, dateFinished: v })}
              helper="If blank: Completed auto-sets to today."
            />
          </div>

          <TextArea
            label="Notes"
            value={String(form.notes || "")}
            onChange={(v) => setForm({ ...form, notes: v })}
            placeholder="Anything you want to remember (who you watched with, thoughts, etc.)"
          />

          <div className="flex items-center justify-between gap-3">
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
            >
              Add to Stack
            </button>

            <Toggle label="Group by month" checked={groupByMonth} onChange={setGroupByMonth} />
          </div>
        </form>

        {/* Tabs + search */}
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Tab active={tab === "all"} onClick={() => setTab("all")}>
              All
            </Tab>
            <Tab active={tab === "completed"} onClick={() => setTab("completed")}>
              Completed
            </Tab>
            <Tab active={tab === "watching"} onClick={() => setTab("watching")}>
              Watching
            </Tab>
            <Tab active={tab === "watchlist"} onClick={() => setTab("watchlist")}>
              Watchlist
            </Tab>
            <Tab active={tab === "dropped"} onClick={() => setTab("dropped")}>
              Dropped
            </Tab>
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, notes, tags..."
            className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
          />
        </section>

        {/* All tab = Drag board */}
        {tab === "all" ? (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <DropColumn
                id="col:completed"
                title="Completed"
                items={board.completed}
                onDelete={removeItem}
                onUpdate={updateItem}
              />
              <DropColumn
                id="col:in_progress"
                title="Watching"
                items={board.inProg}
                onDelete={removeItem}
                onUpdate={updateItem}
              />
              <DropColumn
                id="col:planned"
                title="Watchlist"
                items={board.planned}
                onDelete={removeItem}
                onUpdate={updateItem}
              />
              <DropColumn
                id="col:dropped"
                title="Dropped"
                items={board.dropped}
                onDelete={removeItem}
                onUpdate={updateItem}
              />
            </div>

            <div className="text-xs text-neutral-500 mt-2">
              Tip: drag a card into a column to change its status.
            </div>
          </DndContext>
        ) : (
          <>
            {/* List (non-all tabs) */}
            {groupByMonth && grouped ? (
              <div className="space-y-6">
                {grouped.map(([k, list]) => (
                  <section key={k} className="space-y-2">
                    <h3 className="text-sm text-neutral-400">{k}</h3>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {list.map((i) => (
                        <MediaCard key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={updateItem} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map((i) => (
                  <MediaCard key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={updateItem} />
                ))}
              </div>
            )}
          </>
        )}

        <footer className="pt-6 text-xs text-neutral-500">
          Stack • Saves to Supabase + local backup • Auto-fill uses TMDB for movies/TV
        </footer>

        <input ref={fileInputRef} type="file" className="hidden" />
      </div>
    </div>
  );
}

/* ================= DND COLUMN ================= */

function DropColumn({
  id,
  title,
  items,
  onDelete,
  onUpdate,
}: {
  id: string;
  title: string;
  items: MediaItem[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<MediaItem>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <section
      ref={setNodeRef}
      className={[
        "rounded-2xl ring-1 p-3 min-h-[140px]",
        isOver ? "bg-white/10 ring-white/20" : "bg-neutral-900/40 ring-neutral-800/80",
      ].join(" ")}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-neutral-200">{title}</h3>
        <div className="text-xs text-neutral-500">{items.length}</div>
      </div>

      <div className="space-y-3">
        {items.map((i) => (
          <DraggableCard key={i.id} item={i} onDelete={() => onDelete(i.id)} onUpdate={onUpdate} />
        ))}

        {items.length === 0 ? (
          <div className="text-xs text-neutral-500">Drop here</div>
        ) : null}
      </div>
    </section>
  );
}

function DraggableCard({
  item,
  onDelete,
  onUpdate,
}: {
  item: MediaItem;
  onDelete: () => void;
  onUpdate: (id: string, patch: Partial<MediaItem>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `item:${item.id}`,
  });

  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        "rounded-2xl overflow-hidden ring-1 shadow-sm",
        isDragging ? "bg-neutral-900/70 ring-white/20" : "bg-neutral-900/50 ring-neutral-800/80",
      ].join(" ")}
    >
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium truncate text-sm">{item.title}</div>
            <div className="text-[11px] text-neutral-400">
              {item.type}
              {typeof item.rating === "number" ? ` • ${item.rating.toFixed(1)}/10` : ""}
              {item.inTheaters ? " • theaters" : ""}
              {(item.rewatchCount ?? 0) > 0 ? ` • rewatch x${item.rewatchCount}` : ""}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
              title="Drag"
            >
              Drag
            </button>

            <button
              type="button"
              onClick={onDelete}
              className="text-[11px] px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
              title="Delete"
            >
              Delete
            </button>
          </div>
        </div>

        {/* quick rating edit */}
        <div className="mt-2">
          <MiniRating
            value={item.rating}
            onChange={(v) => onUpdate(item.id, { rating: v })}
          />
        </div>

        {item.notes ? <div className="mt-2 text-[11px] text-neutral-300 line-clamp-2">{item.notes}</div> : null}
      </div>
    </div>
  );
}

/* ================= COMPONENTS ================= */

function MediaCard({
  item,
  onDelete,
  onUpdate,
}: {
  item: MediaItem;
  onDelete: () => void;
  onUpdate: (id: string, patch: Partial<MediaItem>) => void;
}) {
  return (
    <article className="bg-neutral-900/50 rounded-2xl overflow-hidden ring-1 ring-neutral-800/80 shadow-sm">
      <div className="flex gap-3 p-4">
        <div className="w-14 h-20 rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800 shrink-0">
          {item.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.posterUrl} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-500">No cover</div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate">{item.title}</div>
              <div className="text-xs text-neutral-400">
                {item.type} • {labelStatus(item.status)}
                {typeof item.rating === "number" ? ` • ${item.rating.toFixed(1)}/10` : ""}
                {item.inTheaters ? " • in theaters" : ""}
                {item.dateFinished ? ` • ${item.dateFinished}` : ""}
                {(item.rewatchCount ?? 0) > 0 ? ` • rewatch x${item.rewatchCount}` : ""}
              </div>
            </div>

            <button
              type="button"
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 shrink-0"
              title="Delete"
            >
              Delete
            </button>
          </div>

          {/* quick rating edit */}
          <MiniRating
            value={item.rating}
            onChange={(v) => onUpdate(item.id, { rating: v })}
          />

          {item.notes ? <div className="text-xs text-neutral-300 line-clamp-2">{item.notes}</div> : null}
          {item.tags?.length ? (
            <div className="text-[11px] text-neutral-500 truncate">{item.tags.join(" • ")}</div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function MiniRating({
  value,
  onChange,
}: {
  value?: number;
  onChange: (v: number | undefined) => void;
}) {
  const display = typeof value === "number" ? value : undefined;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-neutral-400">Rating</span>
      <select
        value={display ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") onChange(undefined);
          else onChange(clampRating(Number(raw)));
        }}
        className="text-[11px] rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 outline-none focus:border-neutral-500"
      >
        <option value="">—</option>
        {Array.from({ length: 21 }).map((_, i) => {
          const v = i * 0.5; // 0.0 to 10.0
          return (
            <option key={v} value={v}>
              {v.toFixed(1)}
            </option>
          );
        })}
      </select>
      {typeof display === "number" ? (
        <span className="text-[11px] text-neutral-500">/10</span>
      ) : null}
    </div>
  );
}

function labelStatus(s: Status) {
  if (s === "planned") return "watchlist";
  if (s === "in_progress") return "watching";
  return s;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 rounded-xl border text-sm ${
        active ? "bg-white/15 border-white/20" : "bg-white/5 border-white/10 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
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
  max,
  step,
  allowEmpty,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  allowEmpty?: boolean;
}) {
  const [raw, setRaw] = useState<string>(() => (allowEmpty ? "" : String(value)));

  useEffect(() => {
    if (!allowEmpty) {
      setRaw(String(Number.isFinite(value) ? value : 0));
    }
  }, [value, allowEmpty]);

  return (
    <label className="block">
      <div className="text-xs mb-1 text-neutral-400">{label}</div>
      <input
        type="number"
        value={allowEmpty ? raw : String(Number.isFinite(value) ? value : 0)}
        onChange={(e) => {
          const next = e.target.value;
          if (allowEmpty) setRaw(next);
          const n = Number(next);
          if (next === "" && allowEmpty) return;
          onChange(n);
        }}
        onBlur={() => {
          if (!allowEmpty) return;
          if (raw.trim() === "") return;
          const n = Number(raw);
          if (!Number.isFinite(n)) setRaw("");
        }}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        className={`w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500 ${
          disabled ? "opacity-50" : ""
        }`}
      />
    </label>
  );
}