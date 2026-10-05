"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Script from "next/script";
import { ROUTE_META, RouteKey, DAY_NAMES, SOURCE_NOTE, MATCH_COVERAGE_THRESHOLD_PCT } from "./constants";
import type { RouteResponse } from "./types";

declare global {
  interface Window {
    kakao: any;
  }
}

const KAKAO_JS_KEY = process.env.NEXT_PUBLIC_KAKAO_JS_KEY ?? "";
const SEOUL_CENTER = { lat: 37.5665, lng: 126.978 };

type Point = { lat: number; lng: number } | null;

function markerImage(kakao: any, color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.27 21.73 0 14 0z" fill="${color}"/>
    <circle cx="14" cy="14" r="5.5" fill="white"/>
  </svg>`;
  const url = "data:image/svg+xml;base64," + btoa(svg);
  return new kakao.maps.MarkerImage(url, new kakao.maps.Size(28, 38), { offset: new kakao.maps.Point(14, 38) });
}

async function fetchRoute(qs: string): Promise<{ ok: true; data: RouteResponse } | { ok: false; status: number; detail: string }> {
  try {
    const res = await fetch(`/api/route?${qs}`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as RouteResponse;
      return { ok: true, data };
    }
    const body = await res.json().catch(() => ({ detail: "요청을 처리할 수 없습니다." }));
    return { ok: false, status: res.status, detail: body.detail ?? "요청을 처리할 수 없습니다." };
  } catch (e) {
    return { ok: false, status: 0, detail: "서버와 통신할 수 없습니다." };
  }
}

export default function Home() {
  const mapRef = useRef<any>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const originMarkerRef = useRef<any>(null);
  const destMarkerRef = useRef<any>(null);
  const polylineRefs = useRef<any[]>([]);
  const [sdkReady, setSdkReady] = useState(false);

  const [origin, setOrigin] = useState<Point>(null);
  const [destination, setDestination] = useState<Point>(null);
  const [dow, setDow] = useState(1); // 화요일
  const [hour, setHour] = useState(18);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteResponse | null>(null);

  // ---- 지도 초기화 ----
  useEffect(() => {
    if (!sdkReady || !mapDivRef.current) return;
    window.kakao.maps.load(() => {
      const map = new window.kakao.maps.Map(mapDivRef.current, {
        center: new window.kakao.maps.LatLng(SEOUL_CENTER.lat, SEOUL_CENTER.lng),
        level: 7,
      });
      mapRef.current = map;
      window.kakao.maps.event.addListener(map, "click", (e: any) => {
        const lat = e.latLng.getLat();
        const lng = e.latLng.getLng();
        handleMapClick(lat, lng);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady]);

  function handleMapClick(lat: number, lng: number) {
    setError(null);
    setOrigin((prevOrigin) => {
      if (prevOrigin && !destinationRef.current) {
        // 이미 출발지만 있는 상태 → 이번 클릭은 도착지
        setDestination({ lat, lng });
        return prevOrigin;
      }
      // 출발지가 없거나, 출발·도착이 모두 이미 있던 상태(새로 시작) → 새 출발지로 리셋
      setDestination(null);
      setResult(null);
      return { lat, lng };
    });
  }

  // destination을 클로저 밖에서 최신값으로 참조하기 위한 ref
  const destinationRef = useRef<Point>(null);
  useEffect(() => {
    destinationRef.current = destination;
  }, [destination]);

  // ---- 마커 그리기 ----
  useEffect(() => {
    if (!mapRef.current || !window.kakao) return;
    const kakao = window.kakao;
    if (originMarkerRef.current) originMarkerRef.current.setMap(null);
    if (origin) {
      originMarkerRef.current = new kakao.maps.Marker({
        map: mapRef.current,
        position: new kakao.maps.LatLng(origin.lat, origin.lng),
        image: markerImage(kakao, "#111111"),
      });
    }
  }, [origin]);

  useEffect(() => {
    if (!mapRef.current || !window.kakao) return;
    const kakao = window.kakao;
    if (destMarkerRef.current) destMarkerRef.current.setMap(null);
    if (destination) {
      destMarkerRef.current = new kakao.maps.Marker({
        map: mapRef.current,
        position: new kakao.maps.LatLng(destination.lat, destination.lng),
        image: markerImage(kakao, "#0F9D6E"),
      });
    }
  }, [destination]);

  // ---- 경로 요청 ----
  const runQuery = useCallback(async () => {
    if (!origin || !destination) return;
    setLoading(true);
    setError(null);
    setResult(null);
    const qs = new URLSearchParams({
      from_lon: String(origin.lng),
      from_lat: String(origin.lat),
      to_lon: String(destination.lng),
      to_lat: String(destination.lat),
      dow: String(dow),
      hour: String(hour),
    }).toString();
    const res = await fetchRoute(qs);
    setLoading(false);
    if (!res.ok) {
      setError(res.detail);
      return;
    }
    setResult(res.data);
  }, [origin, destination, dow, hour]);

  useEffect(() => {
    if (origin && destination) runQuery();
  }, [origin, destination, dow, hour, runQuery]);

  // ---- 경로 폴리라인 그리기 ----
  useEffect(() => {
    if (!mapRef.current || !window.kakao) return;
    const kakao = window.kakao;
    polylineRefs.current.forEach((p) => p.setMap(null));
    polylineRefs.current = [];
    if (!result) return;

    const draw = (key: RouteKey, coords: [number, number][]) => {
      if (!coords || coords.length < 2) return;
      const meta = ROUTE_META[key];
      const path = coords.map(([lon, lat]) => new kakao.maps.LatLng(lat, lon));
      const line = new kakao.maps.Polyline({
        map: mapRef.current,
        path,
        strokeWeight: meta.weight,
        strokeColor: meta.color,
        strokeOpacity: meta.opacity,
        strokeStyle: meta.dash ? "shortdash" : "solid",
      });
      polylineRefs.current.push(line);
    };

    // 뒤에 그리는 게 위로 올라오므로 강조선(reliable)을 마지막에 그림
    if (!("error" in result.kakao) && result.kakaoMatch && result.kakaoMatch.coverage_pct >= MATCH_COVERAGE_THRESHOLD_PCT) {
      draw("kakaoModel", result.kakao.coords);
    }
    draw("reliable", result.routes.reliable.coords);

    // 경로 전체가 보이도록 bounds 조정
    const bounds = new kakao.maps.LatLngBounds();
    result.routes.reliable.coords.forEach(([lon, lat]: [number, number]) => bounds.extend(new kakao.maps.LatLng(lat, lon)));
    if (!bounds.isEmpty()) mapRef.current.setBounds(bounds);
  }, [result]);

  function handleReset() {
    setOrigin(null);
    setDestination(null);
    setResult(null);
    setError(null);
  }

  const kakaoOk = result && !("error" in result.kakao);
  const kakaoFailed = result && "error" in result.kakao;
  const kakaoMatch = kakaoOk ? result!.kakaoMatch : null;
  const matchReliable = kakaoMatch !== null && kakaoMatch.coverage_pct >= MATCH_COVERAGE_THRESHOLD_PCT;
  const fairDiff = matchReliable ? kakaoMatch!.est_min - result!.routes.reliable.est_min : null;

  return (
    <div className="layout">
      <Script
        src={`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&autoload=false`}
        onLoad={() => setSdkReady(true)}
        strategy="afterInteractive"
      />

      <div className="map-area">
        <div id="kakao-map" ref={mapDivRef} />

        {!origin && (
          <div className="map-hint">지도를 클릭해 출발지를 찍으세요</div>
        )}
        {origin && !destination && (
          <div className="map-hint">지도를 한 번 더 클릭해 도착지를 찍으세요</div>
        )}

        <div className="map-overlay-top">
          <select value={dow} onChange={(e) => setDow(Number(e.target.value))}>
            {DAY_NAMES.map((d, i) => (
              <option key={i} value={i}>{d}요일</option>
            ))}
          </select>
          <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{h}시</option>
            ))}
          </select>
        </div>

        <div className="map-overlay-bottom">
          {(Object.keys(ROUTE_META) as RouteKey[]).map((k) => (
            <div className="legend-row" key={k}>
              <span
                className="legend-line"
                style={{ borderTopColor: ROUTE_META[k].color, borderTopStyle: ROUTE_META[k].dash ? "dashed" : "solid" }}
              />
              {ROUTE_META[k].label}
            </div>
          ))}
        </div>
      </div>

      <div className="side-panel">
        <div className="drag-handle" />
        <div className="side-header">
          <h1>안 멈추는 길</h1>
          <p>서울 주요도로 실측 기반 경로와 카카오 경로를 비교합니다</p>
        </div>

        {(origin || destination) && (
          <div className="od-summary">
            <div className="od-row"><span className="od-dot" style={{ background: "#111111" }} /> 출발 {result ? result.snapped.src : origin ? "선택됨" : "미선택"}</div>
            <div className="od-row"><span className="od-dot" style={{ background: "#0F9D6E" }} /> 도착 {result ? result.snapped.dst : destination ? "선택됨" : "미선택"}</div>
          </div>
        )}

        {result && result.snapped.src_m > 500 && (
          <div className="snap-warn">출발지가 가장 가까운 교차로({result.snapped.src}, {Math.round(result.snapped.src_m)}m)로 조정됐습니다</div>
        )}
        {result && result.snapped.dst_m > 500 && (
          <div className="snap-warn">도착지가 가장 가까운 교차로({result.snapped.dst}, {Math.round(result.snapped.dst_m)}m)로 조정됐습니다</div>
        )}

        {loading && (
          <div className="loading-banner"><span className="spinner" /> 계산 중…</div>
        )}
        {error && <div className="error-banner">{error}</div>}

        {result && kakaoOk && matchReliable && (
          <div className={`boost-card ${fairDiff! > 0.05 ? "win" : "tie"}`}>
            <div className="headline">
              {fairDiff! > 0.05
                ? `카카오 경로 대비 ${fairDiff!.toFixed(1)}분 빠름`
                : fairDiff! < -0.05
                ? `카카오 경로보다 ${Math.abs(fairDiff!).toFixed(1)}분 차이`
                : "카카오 경로와 거의 같은 시간"}
            </div>
            <div className="sub">같은 요일·시간대, 같은 예측 모델 기준 (매칭 커버리지 {kakaoMatch!.coverage_pct}%)</div>
          </div>
        )}
        {result && kakaoOk && kakaoMatch !== null && !matchReliable && (
          <div className="boost-card tie">
            <div className="headline">경로가 우리 데이터와 잘 매칭되지 않아 정확한 비교를 보여드리기 어려워요</div>
            <div className="sub">안 늦는 길(우리) 예상 소요시간만 참고해주세요</div>
          </div>
        )}
        {result && kakaoFailed && (
          <div className="kakao-fail">카카오 경로를 불러오지 못했습니다{"error" in result.kakao ? `: ${result.kakao.error}` : ""}</div>
        )}

        {result && (
          <>
            <RouteCard k="reliable" r={result.routes.reliable} emph />
            {kakaoOk && matchReliable && (
              <RouteCard
                k="kakaoModel"
                r={kakaoMatch!}
                footnote={`매칭 커버리지 ${kakaoMatch!.coverage_pct}%`}
              />
            )}
            <div className="source-note">{SOURCE_NOTE}</div>
          </>
        )}

        {(origin || destination) && (
          <button className="reset-btn" onClick={handleReset}>초기화</button>
        )}
      </div>
    </div>
  );
}

function RouteCard({
  k,
  r,
  emph,
  footnote,
}: {
  k: RouteKey;
  r: { dist_km: number; signals: number; roads: string[]; est_min: number; est_p90_min: number };
  emph?: boolean;
  footnote?: string;
}) {
  const meta = ROUTE_META[k];
  return (
    <div className={`route-card ${emph ? "emph" : ""}`} style={emph ? { borderColor: meta.color } : undefined}>
      <div className="title-row">
        <span className="swatch" style={{ background: meta.color }} />
        {meta.label}
      </div>
      <div className="route-stats">
        <div>예상 소요 <b>{r.est_min}분</b></div>
        <div>늦어도 <b>{r.est_p90_min}분</b></div>
        <div>거리 <b>{r.dist_km}km</b></div>
        <div>신호 교차로 <b>{r.signals}개</b></div>
      </div>
      <div className="roads-line">{r.roads.join(" · ")}</div>
      {footnote && <div className="roads-line">{footnote}</div>}
    </div>
  );
}
