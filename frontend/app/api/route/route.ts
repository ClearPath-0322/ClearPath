import { NextRequest, NextResponse } from "next/server";
import { buildRoute, matchKakaoRoute, NODES, snap } from "../../lib/graph";
import { fetchKakaoRoute } from "../../lib/kakao";

const round1 = (x: number) => Math.round(x * 10) / 10;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const fromLon = Number(sp.get("from_lon"));
  const fromLat = Number(sp.get("from_lat"));
  const toLon = Number(sp.get("to_lon"));
  const toLat = Number(sp.get("to_lat"));
  const dow = clampInt(sp.get("dow"), 1, 0, 6);
  const hour = clampInt(sp.get("hour"), 18, 0, 23);

  if (![fromLon, fromLat, toLon, toLat].every(Number.isFinite)) {
    return NextResponse.json({ detail: "좌표가 올바르지 않습니다" }, { status: 400 });
  }

  const src = snap(fromLon, fromLat);
  const dst = snap(toLon, toLat);

  if (src.node === dst.node) {
    return NextResponse.json({ detail: "출발·도착이 같은 교차로입니다. 더 멀리 찍어주세요" }, { status: 400 });
  }

  const shortest = buildRoute(src.node, dst.node, "length", dow, hour);
  const fastest = buildRoute(src.node, dst.node, "mean", dow, hour);
  const reliable = buildRoute(src.node, dst.node, "p90", dow, hour);

  if (!shortest || !fastest || !reliable) {
    return NextResponse.json({ detail: "이 구간은 주요도로 데이터가 없습니다" }, { status: 404 });
  }

  const kakao = await fetchKakaoRoute(NODES[src.node], NODES[dst.node]);
  const kakaoMatch = "error" in kakao ? null : matchKakaoRoute(kakao.coords, dow, hour);

  return NextResponse.json({
    snapped: {
      src: src.node,
      src_m: round1(src.distM),
      dst: dst.node,
      dst_m: round1(dst.distM),
    },
    dow,
    hour,
    routes: { shortest, fastest, reliable },
    kakao,
    kakaoMatch,
  });
}
