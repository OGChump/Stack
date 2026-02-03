/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

export default function FriendsPage() {
  const [me, setMe] = useState<string | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [incoming, setIncoming] = useState<{ id: string; user: any }[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data, error }) => {
      if (error) console.log("getUser error:", error);
      setMe(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!me) return;
    refresh();
  }, [me]);

  async function refresh() {
    if (!me) return;

    // -----------------------
    // Friends list
    // friends table holds directional rows:
    // (user_id = me) -> friend_id
    // -----------------------
    const { data: friendRows, error: friendsErr } = await supabase
      .from("friends")
      .select("friend_id")
      .eq("user_id", me);

    if (friendsErr) console.log("friends select error:", friendsErr);

    const ids = (friendRows ?? []).map((r) => r.friend_id);

    if (!ids.length) {
      setFriends([]);
    } else {
      const { data: profs, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .in("id", ids);

      if (profErr) console.log("profiles (friends) error:", profErr);
      setFriends(profs ?? []);
    }

    // -----------------------
    // Incoming friend requests
    // friend_requests columns:
    // id, requester_id, requested_id, status, created_at
    // -----------------------
    const { data: reqs, error: reqErr } = await supabase
      .from("friend_requests")
      .select("id, requester_id")
      .eq("requested_id", me)
      .eq("status", "pending");

    if (reqErr) console.log("incoming requests error:", reqErr);

    if (!reqs?.length) {
      setIncoming([]);
    } else {
      const requesterIds = reqs.map((r) => r.requester_id);

      const { data: reqProfiles, error: reqProfErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .in("id", requesterIds);

      if (reqProfErr) console.log("profiles (incoming) error:", reqProfErr);

      const map = new Map((reqProfiles ?? []).map((p) => [p.id, p]));
      setIncoming(reqs.map((r) => ({ id: r.id, user: map.get(r.requester_id) })));
    }
  }

  async function sendInvite() {
    if (!inviteUsername.trim() || !me) return;

    setInviteStatus("");

    const username = inviteUsername.trim().toLowerCase();

    // Find user by username
    const { data: userRow, error: findErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (findErr) {
      console.log("lookup error:", findErr);
      setInviteStatus(findErr.message);
      return;
    }

    if (!userRow?.id) {
      setInviteStatus("User not found");
      return;
    }

    if (userRow.id === me) {
      setInviteStatus("You can't friend yourself");
      return;
    }

    // Insert request:
    // requester_id defaults to auth.uid() in your SQL
    // and RLS checks requester_id = auth.uid()
    const { error: insErr } = await supabase
      .from("friend_requests")
      .insert({ requested_id: userRow.id });

    if (insErr) {
      console.log("insert request error:", insErr);
      setInviteStatus(insErr.message);
      return;
    }

    setInviteUsername("");
    setInviteStatus("Invite sent");
    refresh();
  }

  async function respond(requestId: string, action: "accepted" | "rejected") {
    if (!me) return;

    if (action === "accepted") {
      // Use RPC so it:
      // - sets request status to accepted
      // - inserts BOTH rows into friends
      const { error } = await supabase.rpc("accept_friend_request", {
        p_request_id: requestId,
      });

      if (error) {
        console.log("accept_friend_request rpc error:", error);
        return;
      }
    } else {
      // IMPORTANT: your DB constraint uses 'rejected' (not 'declined')
      const { error } = await supabase
        .from("friend_requests")
        .update({ status: "rejected" })
        .eq("id", requestId);

      if (error) {
        console.log("reject error:", error);
        return;
      }
    }

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
              <div
                key={r.id}
                className="flex justify-between border border-neutral-800 p-3 rounded-md"
              >
                <div>{r.user?.display_name || r.user?.username || "Unknown user"}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => respond(r.id, "accepted")}
                    className="px-3 py-1 bg-emerald-600 rounded"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => respond(r.id, "rejected")}
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
