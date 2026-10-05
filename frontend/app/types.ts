export type RouteDetail = {
  dist_km: number;
  signals: number;
  roads: string[];
  coords: [number, number][]; // [lon, lat][]
  est_min: number;
  est_p90_min: number;
};

export type KakaoRoute = {
  duration_min: number;
  dist_km: number;
  coords: [number, number][]; // [lon, lat][]
};

export type KakaoMatchResult = {
  coverage_pct: number;
  dist_km: number;
  signals: number;
  roads: string[];
  est_min: number;
  est_p90_min: number;
};

export type RouteResponse = {
  snapped: { src: string; src_m: number; dst: string; dst_m: number };
  dow: number;
  hour: number;
  routes: {
    shortest: RouteDetail;
    fastest: RouteDetail;
    reliable: RouteDetail;
  };
  kakao: KakaoRoute | { error: string };
  kakaoMatch: KakaoMatchResult | null;
};

export type ApiError = { detail: string };
