const round1 = (x: number) => Math.round(x * 10) / 10;

export type KakaoRoute = { duration_min: number; dist_km: number; coords: [number, number][] } | { error: string };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MIN_LEAD_MS = 15 * 60 * 1000; // 카카오 미래 운행 정보 길찾기는 호출 시점보다 충분히 미래여야 함

// 우리 dow(0=월 ... 6=일)와 hour(0~23)에 해당하는, "지금 이후 가장 가까운 미래"
// KST 날짜/시간을 yyyyMMddHHmm 문자열로 변환한다.
export function nextFutureDepartureTime(dow: number, hour: number): string {
  const kstNow = new Date(Date.now() + KST_OFFSET_MS); // UTC getter == KST 벽시계 값
  const jsTargetDow = (dow + 1) % 7; // 월=0..일=6 -> JS 일=0..토=6

  const target = new Date(kstNow);
  target.setUTCHours(hour, 0, 0, 0);
  const dayDiff = (jsTargetDow - target.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + dayDiff);
  if (target.getTime() <= kstNow.getTime() + MIN_LEAD_MS) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${target.getUTCFullYear()}${pad(target.getUTCMonth() + 1)}${pad(target.getUTCDate())}` +
    `${pad(target.getUTCHours())}${pad(target.getUTCMinutes())}`
  );
}

export async function fetchKakaoRoute(
  src: { lon: number; lat: number },
  dst: { lon: number; lat: number },
  dow: number,
  hour: number
): Promise<KakaoRoute> {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return { error: "KAKAO_REST_API_KEY 환경변수가 설정되어 있지 않습니다." };

  const url = new URL("https://apis-navi.kakaomobility.com/v1/future/directions");
  url.searchParams.set("origin", `${src.lon},${src.lat}`);
  url.searchParams.set("destination", `${dst.lon},${dst.lat}`);
  url.searchParams.set("priority", "RECOMMEND");
  url.searchParams.set("departure_time", nextFutureDepartureTime(dow, hour));

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
