"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function signInWithEmail() {
    setStatus("");
    const e = email.trim();
    if (!e) return;

    const { error } = await supabase.auth.signInWithOtp({ email: e });
    if (error) setStatus(error.message);
    else setStatus("Check your email for the login link.");
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6 grid place-items-center">
        <div className="w-full max-w-md bg-neutral-900/60 ring-1 ring-neutral-800 rounded-2xl p-6 space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Sign in</h1>
            <p className="text-sm text-neutral-400">
              Your data will be saved to your account and synced across computers.
            </p>
          </div>

          <label className="block">
            <div className="text-xs mb-1 text-neutral-300">Email</div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
            />
          </label>

          <button
            onClick={signInWithEmail}
            className="w-full px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10"
          >
            Send login link
          </button>

          {status ? <div className="text-xs text-neutral-400">{status}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="p-3 text-xs text-neutral-400 flex justify-end bg-neutral-950">
        <button
          onClick={signOut}
          className="px-3 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
        >
          Sign out
        </button>
      </div>
      {children}
    </div>
  );
}
