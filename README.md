# ClearPath

서울 주요도로 실측 데이터를 기반으로 예측한 통행시간으로 "안 늦는 길"을 찾아
주고, 이를 카카오내비 경로와 비교해 보여주는 지도 서비스입니다. 지도를 두 번
클릭(출발→도착)하면 두 지점을 가장 가까운 교차로에 스냅한 뒤, 요일·시간대별
예측 통행시간을 가중치로 한 경로를 계산해 지도에 표시합니다.

## 주요 기능

- **지도 클릭 기반 출발/도착 선택**: 카카오맵 위에서 두 번 클릭하면 바로
  경로가 계산됩니다 (`frontend/app/page.tsx`).
- **요일·시간대 선택**: 요일(월~일)과 시간(0~23시)을 바꿔가며 같은 구간의
  예측 통행시간이 어떻게 달라지는지 비교할 수 있습니다.
- **예측 기반 경로 탐색**: 거리 최단, 평균 통행시간 최단, P90(늦어도 이 정도)
  최단 세 가지 가중치로 다익스트라 경로를 계산합니다 (`frontend/app/lib/graph.ts`).
- **카카오내비 경로와의 공정 비교**: 카카오 "미래 운행 정보 길찾기" API로 받은
  경로를 자체 그래프에 맵매칭해, 같은 모델·같은 시간대 기준으로 예상 소요시간을
  환산해서 비교합니다. 매칭 커버리지가 일정 비율(65%) 이상일 때만 비교 카드를
  보여줍니다.
- **교차로 스냅 경고 / 신호등 통과 수 표시**: 클릭한 좌표가 실제 교차로에서
  멀리 떨어져 있으면 경고를 표시하고, 각 경로가 통과하는 신호등 교차로 수를
  계산해 보여줍니다.
- **노드 이름 검색 API**: `/api/nodes?q=` 로 교차로 이름 부분 검색을 지원합니다
  (현재 UI에는 미연결).
- **정기 재학습 파이프라인**: GitHub Actions가 주기적으로 LightGBM 모델을
  재학습하고, 예측 결과(`graph.json`)를 커밋해 Vercel 재배포를 트리거합니다.

## 기술 스택

**프론트엔드**
- Next.js 15 (App Router), React 18, TypeScript
- Kakao Maps JavaScript SDK (지도/마커/폴리라인)
- `proj4` — EPSG:4326(WGS84) ↔ EPSG:5181(GRS80 TM) 좌표 변환

**백엔드(API)**
- Next.js Route Handlers (`app/api/route`, `app/api/nodes`)로 프론트와 동일한
  배포에 통합. 자체 구현한 바이너리 힙 기반 다익스트라로 경로 탐색
- 카카오모빌리티 "미래 운행 정보 길찾기" REST API 연동

**모델 학습 (`model/`)**
- Python, LightGBM(평균 예측 L2 모델 + P90 quantile 모델)
- pandas / numpy / scipy / scikit-learn(DBSCAN, Ridge) / pyproj / openpyxl / pyarrow
- 신호 교차로 지연 추정을 위한 Ridge 회귀(노드 고정효과)

**CI/자동화**
- GitHub Actions (`retrain.yml`): 매일 정해진 시각에 `model/train.py`를 실행해
  `frontend/data/graph.json`을 재생성하고 자동 커밋

## 프로젝트 구조

```
.
├── data/                       # 모델 학습용 원본 데이터
│   ├── speed_05~08.xlsx        # 시간대별 속도 데이터
│   ├── vertex.xlsx             # 링크(도로) 좌표 정보
│   └── signals.csv             # 신호등 위치 정보
│
├── model/
│   ├── train.py                 # 피처 생성 → LightGBM(mean, p90) 학습
│   │                             # → frontend/data/graph.json 생성
│   └── requirements.txt
│
├── .github/workflows/
│   └── retrain.yml              # 주기적으로 train.py 실행 → graph.json 커밋
│
└── frontend/                    # Next.js 15 App Router (Vercel 배포)
    ├── app/
    │   ├── page.tsx              # 지도 클릭 → 경로 계산·비교 화면
    │   ├── layout.tsx
    │   ├── globals.css
    │   ├── constants.ts          # 경로 스타일(색상/굵기), 매칭 커버리지 기준값
    │   ├── types.ts              # API 응답 타입
    │   ├── lib/
    │   │   ├── graph.ts          # graph.json 로드, 좌표 스냅, 다익스트라,
    │   │   │                     # 카카오 경로 맵매칭
    │   │   └── kakao.ts          # 카카오 "미래 운행 정보 길찾기" API 호출
    │   └── api/
    │       ├── route/route.ts    # GET /api/route — 경로 3종 + 카카오 비교
    │       └── nodes/route.ts    # GET /api/nodes — 교차로 이름 검색
    └── data/
        └── graph.json            # train.py가 생성하는 그래프(노드·링크·예측치)
```

## 데이터 흐름

1. `model/train.py`가 `data/` 아래의 속도·좌표·신호등 원본 데이터를 읽어
   링크(도로 구간) 단위 피처를 만들고, LightGBM으로 (링크 × 요일 × 시간대)
   조합별 평균·P90 통행시간을 예측합니다.
2. 예측 결과는 `frontend/data/graph.json`에 노드(교차로 좌표·신호등 여부)와
   링크(길이·좌표·시간대별 예측치) 형태로 저장됩니다.
3. Next.js는 빌드 시 이 파일을 정적 import로 읽어 `frontend/app/lib/graph.ts`의
   그래프 자료구조를 구성합니다 — 런타임에 Python/LightGBM을 호출하지 않습니다.
4. 사용자가 지도를 두 번 클릭하면 `/api/route`가 좌표를 가장 가까운 교차로로
   스냅하고, 거리·평균 시간·P90 시간 세 가지 가중치로 다익스트라를 돌려 경로를
   반환합니다. 동시에 카카오 API로 받은 경로를 같은 그래프에 맵매칭해 비교용
   수치를 계산합니다.

## 로컬 실행

```bash
# 1) 모델 학습 (data/ 폴더에 원본 파일 필요)
cd model
pip install -r requirements.txt
DATA_DIR=../data OUT_DIR=../frontend/data python train.py

# 2) 프론트엔드 + API
cd ../frontend
npm install
cp .env .env.local   # KAKAO_REST_API_KEY, NEXT_PUBLIC_KAKAO_JS_KEY 값 채우기
npm run dev
```

`http://localhost:3000`에서 지도를 두 번 클릭해 출발·도착을 찍으면 경로가
계산됩니다.
