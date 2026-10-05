import { NextRequest, NextResponse } from "next/server";
import { NODE_NAMES, NODES } from "../../lib/graph";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q) {
    return NextResponse.json({ detail: "q is required" }, { status: 400 });
  }

  const hits = NODE_NAMES.filter((n) => n.includes(q)).slice(0, 30);
  return NextResponse.json(hits.map((n) => ({ node: n, lon: NODES[n].lon, lat: NODES[n].lat })));
}
