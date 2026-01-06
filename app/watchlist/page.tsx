"use client";

import AuthGate from "../../components/AuthGate";
import StackApp from "../../components/StackApp";

export default function Page() {
  return (
    <AuthGate>
      <StackApp view="watchlist" />
    </AuthGate>
  );
}
