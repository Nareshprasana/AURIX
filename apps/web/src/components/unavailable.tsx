import { Card, CardTitle } from "../components/ui/card";

export function Unavailable({ title, reason }: { title: string; reason: string }) {
  return (
    <div>
      <h1 className="mb-3 text-xl font-semibold">{title}</h1>
      <Card>
        <CardTitle>Unavailable in this milestone</CardTitle>
        <p className="mt-1 text-sm text-zinc-400">{reason}</p>
      </Card>
    </div>
  );
}
