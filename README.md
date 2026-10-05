# 안 멈추는 길 — 설정 가이드

PRD("안 멈추는 길 — MVP") 기준 구현. PRD 3절은 "실험상 모델 차이가 작아
프로파일만 쓴다"고 했지만, 이 레포는 **LightGBM 예측값을 그대로 서비스에
사용**합니다 (`model/train.py`). 평균(mean)·P90 두 개의 LightGBM 모델을
학습해서 모든 (링크×요일×시간대) 조합의 예측치를 `frontend/data/graph.json`에
저장하고, Next.js API 라우트는 이 파일만 읽어서 그래프를 만듭니다 — 런타임에
모델을 돌리지 않는 건 PRD와 동일합니다.

프론트엔드(Next.js)와 경로 탐색 로직(과거 FastAPI 백엔드)이 하나의 Vercel
배포로 합쳐져 있습니다. 별도 서버가 없으므로 콜드스타트나 배포 파이프라인
이원화 문제가 없습니다.

```
.
├── model/
│   ├── train.py            # LightGBM(mean, p90) 학습 → frontend/data/graph.json 생성
│   └── requirements.txt
├── data/                    # 원본 데이터 (speed_*.xlsx, vertex.xlsx, signals.csv)
├── .github/workflows/
│   └── retrain.yml          # 주기적으로 train.py 실행 → frontend/data/graph.json 커밋
└── frontend/                 # Next.js 15 App Router (Vercel 배포)
    ├── app/page.tsx           # 지도 클릭 → 경로 4종 비교 화면 (PRD 2절)
    ├── app/constants.ts       # 경로별 색상·굵기 (PRD 2.2)
    ├── app/types.ts
    ├── app/globals.css
    ├── app/lib/graph.ts       # 그래프 로드·좌표 스냅·다익스트라 (과거 app.py)
    ├── app/lib/kakao.ts       # 카카오 길찾기 API 호출
    ├── app/api/route/route.ts # GET /api/route
    ├── app/api/nodes/route.ts # GET /api/nodes
    └── data/graph.json        # train.py가 채우는 그래프 데이터
```

## 동작 원리 (PRD 3절)

1. **GitHub Actions**가 주기적으로 `model/train.py`를 실행:
   - 노트북 1~2절과 동일하게 데이터 로드 → 피처 생성 (정적 속성, 교차로 지연 δ,
     프로파일 bl/bp90/bsd 등)
   - LightGBM 두 개 학습: `mean`(L2) / `p90`(quantile α=0.9)
   - 실시간엔 lag(방금 전 실측)를 알 수 없으므로, 예측용 피처의 lag1/lag7/lag14 등은
     전부 프로파일 평균(bl)으로 채운 뒤 전체 (링크×요일×시간대) 그리드에 대해 예측
   - 결과를 `frontend/data/graph.json`으로 저장 → 자동 커밋
2. **Vercel**이 그 커밋을 받아 Next.js를 재배포 (`app/lib/graph.ts`가 빌드 타임에
   `graph.json`을 정적 import로 읽어 그래프 구성 — LightGBM 자체는 Vercel에서
   돌지 않음)
3. 사용자가 지도를 2번 클릭하면 `/api/route`를 호출:
   - 두 좌표를 가장 가까운 교차로로 스냅(선형 탐색 + EPSG:5181 투영)
   - 다익스트라 3회 (weight=length/mean/p90, 직접 구현한 바이너리 힙 기반) →
     최단거리·최단시간·안늦는길
   - 카카오 길찾기 API 호출 → 소요시간 비교
   - 프론트가 4개 경로를 지도에 그리고, "카카오 대비 N분 단축" 카드를 표시

## 1. GitHub에 올리기

```bash
cd project폴더
git init && git add . && git commit -m "init: 안 멈추는 길 MVP"
git remote add origin https://github.com/<your-id>/<repo-name>.git
git branch -M main && git push -u origin main
```

## 2. 데이터 올리기

`data/`에 `speed_05~08.xlsx`, `vertex.xlsx`, `signals.csv`를 넣고 커밋
(자세한 설명은 `data/README.md`). 파일이 크면 Git LFS 사용을 권장합니다.

## 3. GitHub Actions 1회 수동 실행

레포 → **Actions** → `Retrain LightGBM profiles` → **Run workflow**.
성공하면 `frontend/data/graph.json`이 실제 데이터로 갱신되어 자동 커밋됩니다.
(지금은 A-B-C/A-D-C 더미 테스트 그래프가 들어있어서 빌드는 되지만 실제
도로 데이터는 아닙니다.)

주기는 `.github/workflows/retrain.yml`의 `cron`으로 조절 (기본: 매일 KST 새벽 3시 10분).

## 4. Vercel에 올리기

1. [vercel.com](https://vercel.com) → **Add New Project** → 레포 선택
2. **Root Directory**를 `frontend`로 지정
3. 환경변수 2개 추가
   - `KAKAO_REST_API_KEY` = 카카오 디벨로퍼스 **REST API 키** (서버사이드 전용,
     `NEXT_PUBLIC_` 접두사 없이 등록 — 클라이언트에 노출되지 않음)
   - `NEXT_PUBLIC_KAKAO_JS_KEY` = 카카오 디벨로퍼스 **JavaScript 키** (지도 표시용)
4. **카카오 콘솔 → 내 애플리케이션 → 플랫폼 → Web**에 `http://localhost:3000`과
   Vercel 배포 도메인을 등록해야 지도가 뜹니다.
5. Deploy

이후 Actions가 `frontend/data/graph.json`을 갱신해 push할 때마다 Vercel이
자동 재배포합니다.

## 5. 로컬에서 테스트

```bash
# 1) 모델 학습 (data/ 폴더에 원본 파일 필요)
cd model && pip install -r requirements.txt
DATA_DIR=../data OUT_DIR=../frontend/data python train.py

# 2) 프론트 + API
cd ../frontend
npm install
cp .env .env.local   # KAKAO_REST_API_KEY, NEXT_PUBLIC_KAKAO_JS_KEY 값 채우기
npm run dev
```

`http://localhost:3000`에서 지도를 두 번 클릭해 출발·도착을 찍고 비교해보세요.

---

## PRD와 다른 점 / 참고

- **PRD 3절 "프로파일만 사용"과 달리 LightGBM 예측값을 그대로 씁니다.**
  `graph.json`의 `profile` 배열이 어떻게 만들어졌는지 API 라우트는 신경 쓰지
  않으므로, 나중에 다시 "단순 프로파일"로 되돌리고 싶으면 `model/train.py`만
  바꾸면 됩니다(API·프론트는 그대로).
- **모바일 바텀시트**는 "탭해서 펼치고 접는" 수준으로 단순화했습니다. 실제
  드래그 제스처(관성 스크롤 등)가 필요하면 `frontend/app/page.tsx`의
  `.side-panel`에 포인터 이벤트 기반 드래그 로직을 추가하세요.
- **노드 이름 검색 자동완성**(`/api/nodes?q=`)은 API로 준비돼 있지만,
  현재 프론트는 "지도 클릭"만 구현했습니다. 주소 검색창을 추가하려면
  이 API를 그대로 쓰면 됩니다.
- 데이터가 커서 `frontend/data/graph.json`이 무거워지면(링크 수·요일·시간대
  조합이 많아질수록) Vercel 서버리스 함수 번들이 커질 수 있습니다. 필요하면
  profile 소수점을 더 줄이거나, nodes/links/profile을 여러 파일로 분리하는
  방식을 검토하세요.
