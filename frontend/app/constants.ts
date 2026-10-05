export const ROUTE_META = {
  reliable: { label: "안 늦는 길 (우리)", color: "#0F9D6E", weight: 7, opacity: 0.95, dash: false },
  kakaoModel: { label: "카카오 경로 (우리 모델 환산)", color: "#8456E8", weight: 5, opacity: 0.9, dash: false },
} as const;

export type RouteKey = keyof typeof ROUTE_META;

export const DAY_NAMES = ["월", "화", "수", "목", "금", "토", "일"];

// 카카오 경로를 우리 그래프에 맵매칭했을 때, 이 비율(%) 이상 매칭돼야
// "공정 비교"를 신뢰할 수 있다고 보고 배너/카드에 노출한다.
export const MATCH_COVERAGE_THRESHOLD_PCT = 65;

export const SOURCE_NOTE =
  "소요시간은 서울시 TOPIS 택시 GPS 실측(2026.5~7월) 요일·시간대 프로파일을 LightGBM으로 보정한 예측치입니다. " +
  "카카오 예상시간은 호출 시점 실시간 기준이라 참고용입니다.";
