"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSignedIn(!!data.session);
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setSignedIn(!!session);
      setReady(true);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!ready) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 grid place-items-center">
        <div className="text-sm text-neutral-400">Loading…</div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 grid place-items-center p-6">
        <div className="w-full max-w-sm space-y-4 rounded-2xl bg-neutral-900/50 ring-1 ring-neutral-800/80 p-6">
          <div>
            <div className="text-lg font-semibold">Sign in</div>
            <div className="text-sm text-neutral-400">Log in to access your Stack.</div>
          </div>

          <button
            onClick={() => supabase.auth.signInWithOAuth({ provider: "github" })}
            className="w-full px-4 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
          >
            Continue with GitHub
          </button>

          <div className="text-xs text-neutral-500">
            (If you didn’t enable these providers in Supabase Auth, enable at: Authentication → Providers.)
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
