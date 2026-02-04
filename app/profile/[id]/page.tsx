"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type StackItem = {
  id: string;
  title: string;
  category?: string | null; // e.g. "completed", "in_progress", "planned", "dropped"
  type?: string | null; // e.g. "movie" | "tv" | "anime" ...
  rating?: number | null;
  created_at?: string | null;
};

type MediaItemsRow = {
  data: unknown;
};

const CATEGORY_ORDER = ["in_progress", "planned", "completed", "dropped"];
const CATEGORY_LABEL: Record<string, string> = {
  in_progress: "In Progress",
  planned: "Planned",
  completed: "Completed",
  dropped: "Dropped",
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseItemsFromData(data: unknown): StackItem[] {
  // Expecting: { items: [...] }
  if (!data || typeof data !== "object") return [];
  const itemsUnknown = (data as Record<string, unknown>)["items"];
  if (!Array.isArray(itemsUnknown)) return [];

  const out: StackItem[] = [];

  for (const raw of itemsUnknown) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;

    const id = safeString(obj["id"]) ?? crypto.randomUUID();
    const title = safeString(obj["title"]) ?? "(untitled)";
    const category = safeString(obj["category"]) ?? safeString(obj["status"]); // support either key
    const type = safeString(obj["type"]);
    const rating = safeNumber(obj["rating"]);
    const created_at = safeString(obj["created_at"]) ?? safeString(obj["createdAt"]);

    out.push({ id, title, category, type, rating, created_at });
  }

  return out;
}

function formatCategory(cat: string | null | undefined) {
  if (!cat) return "Uncategorized";
  return CATEGORY_LABEL[cat] ?? cat;
}

function sortByTitle(a: StackItem, b: StackItem) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

export default function ProfilePage() {
  const params = useParams();
  const id = (params?.id as string | undefined) ?? undefined;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<StackItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // UI state (like the All page)
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setErrorMsg("");

      // 1) Profile header
      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .eq("id", id)
        .maybeSingle();

      if (cancelled) return;

      if (profErr) {
        console.error("profile fetch error:", profErr);
        setErrorMsg(profErr.message);
        setLoading(false);
        return;
      }

      if (!prof) {
        setErrorMsg("Profile not found or not permitted.");
        setLoading(false);
        return;
      }

      setProfile(prof as Profile);

      // 2) Media items (JSON blob row per user)
      const { data: row, error: rowErr } = await supabase
        .from("media_items")
        .select("data")
        .eq("user_id", id)
        .maybeSingle();

      if (cancelled) return;

      if (rowErr) {
        console.error("media_items fetch error:", rowErr);
        setErrorMsg(rowErr.message);
        setItems([]);
        setLoading(false);
        return;
      }

      const parsed = row ? parseItemsFromData((row as MediaItemsRow).data) : [];
      setItems(parsed);
      setLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const displayName = useMemo(() => {
    if (!profile) return "";
    return profile.display_name || profile.username || profile.id;
  }, [profile]);

  const initials = useMemo(() => getInitials(displayName || "User"), [displayName]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return items.filter((it) => {
      const okCat = categoryFilter === "all" ? true : (it.category ?? "") === categoryFilter;
      const okQuery = !q ? true : it.title.toLowerCase().includes(q);
      return okCat && okQuery;
    });
  }, [items, query, categoryFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, StackItem[]>();

    for (const it of filtered) {
      const key = it.category ?? "uncategorized";
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }

    // sort each group by title (stable + clean)
    for (const [k, arr] of map) {
      map.set(k, [...arr].sort(sortByTitle));
    }

    // build ordered groups: in_progress, planned, completed, dropped, then the rest
    const keys = Array.from(map.keys());
    const ordered: string[] = [];

    for (const k of CATEGORY_ORDER) if (map.has(k)) ordered.push(k);
    if (map.has("uncategorized")) ordered.push("uncategorized");

    for (const k of keys) {
      if (!ordered.includes(k) && !CATEGORY_ORDER.includes(k) && k !== "uncategorized") ordered.push(k);
    }

    return ordered.map((k) => ({ key: k, items: map.get(k) ?? [] }));
  }, [filtered]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto w-full max-w-6xl px-6 py-6 space-y-6">
        <Link href="/friends" className="text-sm text-neutral-400 hover:text-white">
          ← Back to Friends
        </Link>

        {errorMsg && (
          <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
            {errorMsg}
          </div>
        )}

        {/* Header card (matches the site vibe) */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/40 p-5">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-full border border-neutral-700 bg-neutral-900 flex items-center justify-center font-semibold">
              {initials}
            </div>

            <div className="min-w-0">
              <div className="text-2xl font-semibold truncate">{displayName || "Profile"}</div>
              <div className="text-xs text-neutral-500 truncate">{profile?.id}</div>
            </div>

            <div className="ml-auto text-sm text-neutral-400">
              {items.length} item{items.length === 1 ? "" : "s"}
            </div>
          </div>

          {/* Controls row (like All page) */}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              className="w-full sm:flex-1 rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              placeholder="Search titles…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <select
              className="w-full sm:w-56 rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="in_progress">In Progress</option>
              <option value="planned">Planned</option>
              <option value="completed">Completed</option>
              <option value="dropped">Dropped</option>
            </select>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Media</h2>
            {loading ? (
              <div className="text-sm text-neutral-500">Loading…</div>
            ) : (
              <div className="text-sm text-neutral-500">{filtered.length} shown</div>
            )}
          </div>

          {!loading && filtered.length === 0 ? (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-950/40 p-6 text-sm text-neutral-500">
              No media found.
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map((g) => (
                <div key={g.key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-neutral-200">{formatCategory(g.key)}</div>
                    <div className="text-xs text-neutral-500">{g.items.length}</div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {g.items.map((m) => (
                      <div
                        key={m.id}
                        className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4 hover:bg-neutral-900/30 transition"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{m.title || "(untitled)"}</div>
                            <div className="mt-1 text-xs text-neutral-500">
                              {m.type ? m.type : "media"}
                              {m.rating != null ? ` • Rating: ${m.rating}` : ""}
                            </div>
                          </div>

                          {/* subtle badge */}
                          <div className="shrink-0 rounded-full border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300">
                            {formatCategory(m.category)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
