"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AuthGate from "../components/AuthGate";
import { supabase } from "../lib/supabaseClient";

/* ================= TYPES ================= */

type MediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
type Status = "planned" | "in_progress" | "dropped" | "completed";

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;
  rating?: number;
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

/* ================= TMDB ================= */

async function tmdbSearch(title: string, type: "movie" | "tv") {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", title);
  url.searchParams.set("include_adult", "false");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB search failed (${res.status}).`);
  return res.json();
}

async function tmdbDetails(id: number, type: "movie" | "tv") {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/${type}/${id}`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB details failed (${res.status}).`);
  return res.json();
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

  // ✅ Refresh should always start at "All"
  const [tab, setTab] = useState<"all" | "completed" | "watching" | "watchlist" | "dropped">("all");

  const [groupByMonth, setGroupByMonth] = useState(true);
  const [autofillStatus, setAutofillStatus] = useState<string>("");

  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>("");

  // ✅ Default status should be "Completed"
  const [form, setForm] = useState<Partial<MediaItem>>({
    title: "",
    type: "movie",
    status: "completed",
    tags: [],
    inTheaters: false,
    notes: "",
    dateFinished: "",
    rewatchCount: 0,
  });

  // ✅ Rewatch UI helper (derived from rewatchCount)
  const isRewatch = (form.rewatchCount ?? 0) > 0;

  /* ================= LOCAL BACKUP ================= */

  function loadLocalBackup() {
    try {
      const raw = localStorage.getItem(LOCAL_BACKUP_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as MediaItem[];
      return null;
    } catch {
      return null;
    }
  }

  function saveLocalBackup(next: MediaItem[]) {
    try {
      localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(next));
    } catch {}
  }

  /* ================= SUPABASE ================= */

  async function loadCloud(uid: string) {
    setSaveStatus("Loading…");
    setCloudLoaded(false);

    const { data, error } = await supabase
      .from("media_items")
      .select("data")
      .eq("user_id", uid)
      .maybeSingle();

    if (error) {
      console.error(error);
      const backup = loadLocalBackup();
      if (backup) setItems(backup);
      setCloudLoaded(true);
      setSaveStatus("Loaded (local backup)");
      return;
    }

    if (data?.data?.items) {
      setItems(data.data.items);
      saveLocalBackup(data.data.items);
      setCloudLoaded(true);
      setSaveStatus("Loaded");
    } else {
      const ins = await supabase.from("media_items").insert({
        user_id: uid,
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
  }

  async function saveCloud(uid: string, next: MediaItem[]) {
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
  }

  useEffect(() => {
    // instant local load
    const backup = loadLocalBackup();
    if (backup) setItems(backup);

    // ✅ Always reset tab to "All" on page load/refresh
    setTab("all");
  }, []);

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
  }, []);

  useEffect(() => {
    if (userId) saveCloud(userId, items);
    else saveLocalBackup(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, userId, cloudLoaded]);

  /* ================= ACTIONS ================= */

  function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title) return;

    const status = (form.status as Status) ?? "completed";

    // Auto-date logic:
    // - If completed and date is blank => today
    // - If user set a date => use it
    // - Otherwise => undefined
    const manualDate = (form.dateFinished || "").trim();
    const autoDate = status === "completed" ? todayYMD() : "";
    const finalDate = manualDate || autoDate || undefined;

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
      createdAt: new Date().toISOString(),
    };

    setItems((p) => [item, ...p]);

    setAutofillStatus("");
    // ✅ keep defaults optimized for “mostly completed”
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

      setAutofillStatus(`Found: ${hit.title || hit.name}`);

      const d = await tmdbDetails(hit.id, form.type);

      setForm((f) => ({
        ...f,
        posterUrl: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : f.posterUrl,
        runtime: d.runtime ?? d.episode_run_time?.[0] ?? f.runtime,
        tags: (d.genres ?? []).map((g: any) => g.name),
      }));

      setAutofillStatus("Auto-fill complete.");
    } catch (err: any) {
      setAutofillStatus(`TMDB error: ${err?.message || "Unknown error"}`);
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
        <section className="bg-neutral-900/50 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-4">
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

          {/* ✅ Type + Status + (In theaters / Rewatch / Count) all in one clean block */}
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
                onChange={(n) => setForm((f) => ({ ...f, rewatchCount: Math.max(0, Number(n ?? 0) || 0) }))}
                disabled={!isRewatch}
                min={0}
              />
            </div>
          </div>

          {/* Date watched */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Text
              label="Date watched (optional)"
              type="date"
              value={String(form.dateFinished || "")}
              onChange={(v) => setForm({ ...form, dateFinished: v })}
              helper="If blank: Completed auto-sets to today."
            />
          </div>

          {/* Notes */}
          <TextArea
            label="Notes"
            value={String(form.notes || "")}
            onChange={(v) => setForm({ ...form, notes: v })}
            placeholder="Anything you want to remember (who you watched with, thoughts, etc.)"
          />

          <div className="flex items-center justify-between gap-3">
            <button
              type="submit"
              onClick={(e) => addItem(e as any)}
              className="px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
            >
              Add to Stack
            </button>

            <Toggle label="Group by month" checked={groupByMonth} onChange={setGroupByMonth} />
          </div>
        </section>

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

        {/* List */}
        {groupByMonth && grouped ? (
          <div className="space-y-6">
            {grouped.map(([k, list]) => (
              <section key={k} className="space-y-2">
                <h3 className="text-sm text-neutral-400">{k}</h3>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {list.map((i) => (
                    <MediaCard key={i.id} item={i} onDelete={() => removeItem(i.id)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((i) => (
              <MediaCard key={i.id} item={i} onDelete={() => removeItem(i.id)} />
            ))}
          </div>
        )}

        <footer className="pt-6 text-xs text-neutral-500">
          Stack • Saves to Supabase + local backup • Auto-fill uses TMDB for movies/TV
        </footer>

        <input ref={fileInputRef} type="file" className="hidden" />
      </div>
    </div>
  );
}

/* ================= COMPONENTS ================= */

function MediaCard({ item, onDelete }: { item: MediaItem; onDelete: () => void }) {
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

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate">{item.title}</div>
              <div className="text-xs text-neutral-400">
                {item.type} • {labelStatus(item.status)}
                {item.inTheaters ? " • in theaters" : ""}
                {item.dateFinished ? ` • ${item.dateFinished}` : ""}
                {(item.rewatchCount ?? 0) > 0 ? ` • rewatch x${item.rewatchCount}` : ""}
              </div>
            </div>

            <button
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 shrink-0"
              title="Delete"
            >
              Delete
            </button>
          </div>

          {item.notes ? <div className="text-xs text-neutral-300 line-clamp-2">{item.notes}</div> : null}

          {item.tags?.length ? <div className="text-[11px] text-neutral-500 truncate">{item.tags.join(" • ")}</div> : null}
        </div>
      </div>
    </article>
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
