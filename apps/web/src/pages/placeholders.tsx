import { Unavailable } from "../components/unavailable";

export function Research() {
  return <Unavailable title="Research" reason="No verified read API exists for research agents, hypotheses, or evidence bundles. Intake remains caller-supplied by architectural decision (U7); wiring a live feed here would violate the intake-only scope." />;
}

export function Data() {
  return <Unavailable title="Data" reason="No verified read API exists for the dataset catalog, quality reports, or adjustment-policy manifests. Use the versioned on-disk manifests directly until a read API is approved." />;
}

export function Strategies() {
  return <Unavailable title="Strategies" reason="No verified read API exists for strategy definitions, backtest runs, or walk-forward/stress artifacts." />;
}

export function Portfolio() {
  return <Unavailable title="Portfolio" reason="No verified read API exists for positions, allocations, or portfolio snapshots. Nothing is fabricated here." />;
}
