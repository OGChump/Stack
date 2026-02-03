"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useParams } from "next/navigation";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type MediaItem = {
  id: string;
  title: string | null;
  category: string | null;
  rating: number | null;
  created_at?: string | null;
};

export default function ProfilePage() {
  const params = useParams();
  const id = params?.id as string | undefined;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (!id) return;

    async function load() {
      setErrorMsg("");

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .eq("id", id)
        .maybeSingle();

      if (profErr) {
        console.error("profile fetch error:", profErr);
        setErrorMsg(profErr.message);
        return;
      }

      if (!prof) {
        setErrorMsg("Profile not found or not permitted.");
        return;
      }

      setProfile(prof as Profile);

      const { data: items, error: itemsErr } = await supabase
        .from("media_items")
        .select("id, title, category, rating, created_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false });

      if (itemsErr) {
        console.error("media_items fetch error:", itemsErr);
        setErrorMsg(itemsErr.message);
        return;
      }

      setMedia((items ?? []) as MediaItem[]);
    }

    load();
  }, [id]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <Link href="/friends" className="text-sm text-neutral-400 hover:text-white">
          ← Back to Friends
        </Link>

        {errorMsg && (
          <div className="border border-red-900 bg-red-950/30 p-3 rounded-md text-sm text-red-200">
            {errorMsg}
          </div>
        )}

        {profile && (
          <>
            <h1 className="text-3xl font-semibold">
              {profile.display_name || profile.username || profile.id}
            </h1>

            <div className="space-y-2">
              <h2 className="text-lg font-medium">Media</h2>

              {media.length === 0 ? (
                <div className="text-neutral-500 text-sm">No media yet</div>
              ) : (
                media.map((m) => (
                  <div key={m.id} className="border border-neutral-800 p-3 rounded-md">
                    <div className="font-medium">{m.title || "(untitled)"}</div>
                    <div className="text-xs text-neutral-500">
                      {m.category || "All"}
                      {m.rating ? ` • Rating: ${m.rating}` : ""}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
