import { useQuery } from "@tanstack/react-query";
import { Activity, Beaker, Coins, Database, FlaskConical, HeartPulse, LayoutDashboard, Scale, Settings as SettingsIcon, ShieldAlert } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { getHealth } from "../lib/api";
import { cn } from "../lib/utils";
import { ConnectionBadge, useConnectionState } from "./connection";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/research", label: "Research", icon: FlaskConical },
  { to: "/training", label: "Training", icon: Activity },
  { to: "/data", label: "Data", icon: Database },
  { to: "/strategies", label: "Strategies", icon: Beaker },
  { to: "/portfolio", label: "Portfolio", icon: Coins },
  { to: "/risk", label: "Risk and Governance", icon: ShieldAlert },
  { to: "/health", label: "System Health", icon: HeartPulse },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function ScaleIcon() {
  return <Scale className="size-4" aria-hidden="true" />;
}

export function Layout() {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: false, refetchOnWindowFocus: false, staleTime: Infinity });
  const conn = useConnectionState(health);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:p-2 focus:bg-zinc-900">
        Skip to content
      </a>
      <div className="mx-auto flex max-w-6xl flex-col md:flex-row">
        <aside className="border-b border-zinc-800 md:min-h-screen md:w-60 md:border-b-0 md:border-r md:shrink-0">
          <div className="flex items-center gap-2 p-4">
            <ScaleIcon />
            <div>
              <p className="font-semibold tracking-wide">AURIX</p>
              <p className="text-xs text-zinc-500">Trading Intelligence · local</p>
            </div>
          </div>
          <nav aria-label="Primary" className="flex flex-row overflow-x-auto p-2 md:flex-col">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm",
                    isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
                  )
                }
              >
                <item.icon className="size-4" aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="flex-1 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
            <ConnectionBadge state={conn} />
          </div>
          <main id="main">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
