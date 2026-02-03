/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type IncomingRequest = {
  id: string;
  requester_id: string;
  user?: Profile;
};

export default function FriendsPage() {
  const [me, setMe] = useState<string | null>(null);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [incoming, setIncoming] = useState<IncomingRequest[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data, error }) => {
      if (error) {
        console.error("auth.getUser error:", error);
        return;
      }
      setMe(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!me) return;
    refresh();
  }, [me]);

  async function refresh() {
    setInviteStatus("");

    // 1) friends list (IDs)
    const { data: friendRows, error: friendsErr } = await supabase
      .from("friends")
      .select("friend_id")
      .eq("user_id", me);

    if (friendsErr) console.error("friends select error:", friendsErr);

    const ids = (friendRows ?? []).map((r) => r.friend_id);
    if (!ids.length) {
      setFriends([]);
    } else {
      const { data: profs, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .in("id", ids);

      if (profErr) console.error("profiles (friends) select error:", profErr);
      setFriends((profs ?? []) as Profile[]);
    }

    // 2) incoming friend requests
    const { data: reqs, error: reqErr } = await supabase
      .from("friend_requests")
      .select("id, requester_id")
      .eq("requested_id", me)
      .eq("status", "pending");

    if (reqErr) console.error("friend_requests select error:", reqErr);

    if (!reqs?.length) {
      setIncoming([]);
      return;
    }

    const requesterIds = reqs.map((r) => r.requester_id);
    const { data: reqProfiles, error: reqProfErr } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .in("id", requesterIds);

    if (reqProfErr) console.error("profiles (incoming) select error:", reqProfErr);

    const map = new Map((reqProfiles ?? []).map((p) => [p.id, p as Profile]));
    setIncoming(
      reqs.map((r) => ({
        id: r.id,
        requester_id: r.requester_id,
        user: map.get(r.requester_id),
      }))
    );
  }

  async function sendInvite() {
    setInviteStatus("");

    const username = inviteUsername.trim().toLowerCase();
    if (!username) return;
    if (!me) {
      setInviteStatus("Not logged in.");
      return;
    }

    const { data: target, error: findErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (findErr) {
      console.error("find user error:", findErr);
      setInviteStatus("Error finding user");
      return;
    }

    if (!target?.id) {
      setInviteStatus("User not found");
      return;
    }

    if (target.id === me) {
      setInviteStatus("You can’t friend yourself.");
      return;
    }

    // IMPORTANT: use requester_id / requested_id (not requester/requested)
    const { error: insErr } = await supabase.from("friend_requests").insert({
      requester_id: me,
      requested_id: target.id,
      // status is default 'pending'
    });

    if (insErr) {
      console.error("insert friend_request error:", insErr);
      setInviteStatus(insErr.message);
      return;
    }

    setInviteUsername("");
    setInviteStatus("Invite sent");
    await refresh();
  }

  async function acceptRequest(requestId: string) {
    // Accept MUST call RPC so it inserts into friends (both directions)
    const { error } = await supabase.rpc("accept_friend_request", {
      p_request_id: requestId,
    });

    if (error) {
      console.error("accept_friend_request RPC error:", error);
      setInviteStatus(error.message);
      return;
    }

    await refresh();
  }

  async function declineRequest(requestId: string) {
    // Your DB allows 'rejected' (NOT 'declined')
    const { error } = await supabase
      .from("friend_requests")
      .update({ status: "rejected" })
      .eq("id", requestId);

    if (error) {
      console.error("decline request update error:", error);
      setInviteStatus(error.message);
      return;
    }

    await refresh();
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
                <div>{r.user?.display_name || r.user?.username || r.requester_id}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => acceptRequest(r.id)}
                    className="px-3 py-1 bg-emerald-600 rounded"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => declineRequest(r.id)}
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
                {f.display_name || f.username || f.id}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
