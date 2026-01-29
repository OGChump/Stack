"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

export default function FriendsPage() {
  const [me, setMe] = useState<string | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [incoming, setIncoming] = useState<any[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setMe(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!me) return;
    refresh();
  }, [me]);

  async function refresh() {
    // friends
    const { data: friendRows } = await supabase
      .from("friends")
      .select("friend_id")
      .eq("user_id", me);

    const ids = (friendRows ?? []).map((r) => r.friend_id);
    if (!ids.length) {
      setFriends([]);
    } else {
      const { data } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .in("id", ids);
      setFriends(data ?? []);
    }

    // incoming
    const { data: reqs } = await supabase
      .from("friend_requests")
      .select("id, requester")
      .eq("requested", me)
      .eq("status", "pending");

    if (!reqs?.length) {
      setIncoming([]);
    } else {
      const requesterIds = reqs.map((r) => r.requester);
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .in("id", requesterIds);

      const map = new Map((profs ?? []).map((p) => [p.id, p]));
      setIncoming(reqs.map((r) => ({ id: r.id, user: map.get(r.requester) })));
    }
  }

  async function sendInvite() {
    if (!inviteUsername.trim()) return;

    const { data: user } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", inviteUsername.trim())
      .maybeSingle();

    if (!user) {
      setInviteStatus("User not found");
      return;
    }

    await supabase.from("friend_requests").insert({
      requester: me,
      requested: user.id,
    });

    setInviteUsername("");
    setInviteStatus("Invite sent");
    refresh();
  }

  async function respond(id: string, status: "accepted" | "declined") {
    await supabase.from("friend_requests").update({ status }).eq("id", id);
    refresh();
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <Link href="/" className="text-sm text-neutral-400 hover:text-white">
          ← Back
        </Link>

        <h1 className="text-3xl font-semibold">Friends</h1>

        {/* Add friend */}
        <div className="rounded-xl border border-neutral-800 p-4 space-y-2">
          <div className="font-medium">Add friend</div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2"
              placeholder="username"
              value={inviteUsername}
              onChange={(e) => setInviteUsername(e.target.value)}
            />
            <button
              onClick={sendInvite}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500"
            >
              Send
            </button>
          </div>
          {inviteStatus && <div className="text-sm text-neutral-400">{inviteStatus}</div>}
        </div>

        {/* Incoming */}
        {incoming.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-lg font-medium">Incoming</h2>
            {incoming.map((r) => (
              <div key={r.id} className="flex justify-between border border-neutral-800 p-3 rounded-md">
                <div>{r.user?.username}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => respond(r.id, "accepted")}
                    className="px-3 py-1 bg-emerald-600 rounded"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => respond(r.id, "declined")}
                    className="px-3 py-1 bg-neutral-700 rounded"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Friends */}
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Friends</h2>
          {friends.length === 0 ? (
            <div className="text-neutral-500 text-sm">No friends yet</div>
          ) : (
            friends.map((f) => (
              <div key={f.id} className="border border-neutral-800 p-3 rounded-md">
                {f.display_name || f.username}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
