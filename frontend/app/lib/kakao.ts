const round1 = (x: number) => Math.round(x * 10) / 10;

export type KakaoRoute = { duration_min: number; dist_km: number; coords: [number, number][] } | { error: string };

export async function fetchKakaoRoute(
  src: { lon: number; lat: number },
  dst: { lon: number; lat: number }
): Promise<KakaoRoute> {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return { error: "KAKAO_REST_API_KEY 환경변수가 설정되어 있지 않습니다." };

  const url = new URL("https://apis-navi.kakaomobility.com/v1/directions");
  url.searchParams.set("origin", `${src.lon},${src.lat}`);
  url.searchParams.set("destination", `${dst.lon},${dst.lat}`);
  url.searchParams.set("priority", "RECOMMEND");

  try {
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const js = await res.json();
    const route = js?.routes?.[0];
    if (!route || route.result_code !== 0) return { error: "카카오 경로를 찾을 수 없습니다." };

    const coords: [number, number][] = [];
    for (const section of route.sections ?? []) {
      for (const road of section.roads ?? []) {
        const vv: number[] = road.vertexes ?? [];
        for (let i = 0; i < vv.length; i += 2) coords.push([vv[i], vv[i + 1]]);
      }
    }
    return {
      duration_min: round1(route.summary.duration / 60),
      dist_km: round1(route.summary.distance / 1000),
      coords,
    };
  } catch (e) {
    return { error: `카카오 API 호출 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}
