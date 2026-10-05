"""
"안 멈추는 길" 모델 학습 스크립트 — LightGBM 버전.
원본 Colab 노트북(2_final_experiment_TEAM_light.ipynb)의 1~3절
(데이터 로드 · 전처리 · 피처 · LightGBM)을 백엔드가 쓰는 형태로 재구성.

PRD와의 차이: PRD 3절은 "실험에서 모델 간 차이가 작아 프로파일만 쓴다"고
했지만, 이 버전은 LightGBM 예측값을 그대로 서비스에 쓴다. 그래서
profiles.parquet의 mean/p90은 TT3의 단순 평균/분위가 아니라,
LightGBM(mean 모델 = L2, p90 모델 = quantile alpha=0.9)의 예측값이다.

실시간 제약: 서비스가 실제 호출 시점엔 "방금 전 실측(lag)"을 모르므로,
예측용 피처 행렬을 만들 때 lag1/lag7/lag14/lagw/up7/dn7은 모두
"링크·요일·시 프로파일 평균(bl)"으로 채운다. 즉 LightGBM이 정적 속성
(길이·차선·기능유형·교차로 지연 등)으로 프로파일을 보정한 값.

입력 (DATA_DIR, 기본 'data/'):
  - speed_*.xlsx
  - vertex.xlsx
  - signals.csv

출력 (OUT_DIR, 기본 'frontend/data/'):
  - graph.json   Next.js API 라우트(frontend/app/api/route)가 fs 없이
    정적 import로 읽는 그래프 파일. 스키마:
    {
      "nodes": { "<node>": [lon, lat, has_signal], ... },
      "links": {
        "<linkId>": {
          "road": str, "length": float, "u": str, "v": str,
          "coords": [[lon,lat], ...],
          "profile": [ [mean,p90] | null, ... ]  # 168개, idx = dow*24+hour, 초 단위
        }, ...
      }
    }
"""
import os
import glob
import json
import time
import warnings

import numpy as np
import pandas as pd
from pyproj import Transformer
from sklearn.cluster import DBSCAN
from sklearn.linear_model import Ridge
from scipy.spatial import cKDTree
from scipy import sparse
import lightgbm as lgb

warnings.filterwarnings("ignore")

DATA_DIR = os.environ.get("DATA_DIR", "data")
OUT_DIR = os.environ.get("OUT_DIR", "frontend/data")
TRAIN_MONTHS = [int(x) for x in os.environ.get("TRAIN_MONTHS", "5,6,7").split(",")]
N_ESTIMATORS = int(os.environ.get("N_ESTIMATORS", "600"))
Q = 0.9  # p90

log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # ---------------------------------------------------
    # 1. 데이터 로드 (노트북 1절)
    # ---------------------------------------------------
    cache = os.path.join(DATA_DIR, "speed_raw.parquet")
    if not os.path.exists(cache):
        files = sorted(glob.glob(os.path.join(DATA_DIR, "speed_*.xlsx")))
        if not files:
            raise FileNotFoundError(f"{DATA_DIR}/speed_*.xlsx 파일을 찾을 수 없습니다.")
        frames = [pd.read_excel(f, engine="openpyxl") for f in files]
        pd.concat(frames, ignore_index=True).to_parquet(cache)
    speed = pd.read_parquet(cache)
    HRS = [c for c in speed.columns if c.endswith("시")]
    speed["date"] = pd.to_datetime(speed["일자"].astype(str))
    log("속도 행", len(speed), "링크", speed["링크아이디"].nunique(), "일수", speed["date"].nunique())

    links = speed.drop_duplicates("링크아이디")[
        ["링크아이디", "도로명", "시점명", "종점명", "거리", "차선수", "기능유형구분", "도심/외곽구분"]
    ].reset_index(drop=True)

    v = pd.read_excel(os.path.join(DATA_DIR, "vertex.xlsx"))
    v["LINK_ID"] = v["LINK_ID"].astype("int64")
    v = v.sort_values(["LINK_ID", "VER_SEQ"])
    first, last = v.groupby("LINK_ID").first(), v.groupby("LINK_ID").last()
    links = links.merge(first.rename(columns={"GRS80TM_X": "sx", "GRS80TM_Y": "sy"})[["sx", "sy"]], left_on="링크아이디", right_index=True, how="left")
    links = links.merge(last.rename(columns={"GRS80TM_X": "ex", "GRS80TM_Y": "ey"})[["ex", "ey"]], left_on="링크아이디", right_index=True, how="left")
    links = links.dropna(subset=["sx", "ex"]).reset_index(drop=True)

    # 노드(교차로): 이름 + 위치 클러스터(동명이지 분리, eps=150m)
    ends = pd.concat([
        links[["링크아이디", "시점명", "sx", "sy"]].assign(side="s").rename(columns={"시점명": "name", "sx": "x", "sy": "y"}),
        links[["링크아이디", "종점명", "ex", "ey"]].assign(side="e").rename(columns={"종점명": "name", "ex": "x", "ey": "y"}),
    ]).reset_index(drop=True)
    ends["nid"] = None
    for name, grp in ends.groupby("name"):
        lab = DBSCAN(eps=150, min_samples=1).fit_predict(grp[["x", "y"]].values)
        ends.loc[grp.index, "nid"] = [name if lab.max() == 0 else f"{name}#{l}" for l in lab]
    ends["nid"] = ends["nid"].astype(str)
    links["u"] = links["링크아이디"].map(ends[ends.side == "s"].set_index("링크아이디")["nid"])
    links["v"] = links["링크아이디"].map(ends[ends.side == "e"].set_index("링크아이디")["nid"])
    nodes = ends.groupby("nid").agg(x=("x", "mean"), y=("y", "mean"))
    to_wgs = Transformer.from_crs("EPSG:5181", "EPSG:4326", always_xy=True)
    nodes["lon"], nodes["lat"] = to_wgs.transform(nodes.x.values, nodes.y.values)

    # 신호등: 부착대 → 교차로(40m) → 노드 60m 매칭
    sig = pd.read_csv(os.path.join(DATA_DIR, "signals.csv"), encoding="cp949")
    sig = sig[sig["상태"] == 1].copy()
    t2 = Transformer.from_crs("EPSG:5186", "EPSG:5181", always_xy=True)
    sig["x"], sig["y"] = t2.transform(sig["X좌표"].values, sig["Y좌표"].values)
    sig["cl"] = DBSCAN(eps=40, min_samples=1).fit_predict(sig[["x", "y"]].values)
    inter = sig.groupby("cl").agg(x=("x", "mean"), y=("y", "mean"), n=("신호등수량", "sum")).reset_index()
    d, i = cKDTree(inter[["x", "y"]].values).query(nodes[["x", "y"]].values, distance_upper_bound=60)
    ok = np.isfinite(d)
    nodes["signals"] = 0
    nodes.loc[ok, "signals"] = inter.n.values[i[ok]]
    nodes["has_signal"] = (nodes.signals > 0).astype(int)
    nodes["deg_out"] = links.groupby("u").size().reindex(nodes.index).fillna(0).astype(int)

    # 지도용 geometry
    v["lon"], v["lat"] = to_wgs.transform(v.GRS80TM_X.values, v.GRS80TM_Y.values)
    geom = {int(l): list(zip(g.lon.round(6), g.lat.round(6))) for l, g in v.groupby("LINK_ID")}

    # 3차원 통행시간 배열
    LIDS = links["링크아이디"].values
    LIDX = {l: i for i, l in enumerate(LIDS)}
    DATES = np.sort(speed["date"].unique())
    DIDX = {d: i for i, d in enumerate(DATES)}
    sp = speed[speed["링크아이디"].isin(LIDX)]
    TT3 = np.full((len(LIDS), len(DATES), 24), np.nan, dtype="float32")
    li = sp["링크아이디"].map(LIDX).values
    di = sp["date"].map(DIDX).values
    TT3[li, di, :] = sp["거리"].to_numpy("float32")[:, None] / (sp[HRS].to_numpy("float32") * 1000 / 3600)
    DOW = np.array([pd.Timestamp(d).dayofweek for d in DATES])
    MON = np.array([pd.Timestamp(d).month for d in DATES])
    TRAIN_D = np.isin(MON, TRAIN_MONTHS)
    log("TT3", TT3.shape, "결측 비율 %.4f" % np.isnan(TT3).mean())

    # ---------------------------------------------------
    # 2. 피처 (노트북 2절과 동일한 정의)
    # ---------------------------------------------------
    L = len(LIDS)

    def prof_stat(fn):
        out = np.full((L, 7, 24), np.nan, "float32")
        for w in range(7):
            m = TRAIN_D & (DOW == w)
            if m.any():
                out[:, w, :] = fn(TT3[:, m, :], axis=1)
        return out

    P_MEAN = prof_stat(np.nanmean)
    P_P90 = prof_stat(lambda a, axis: np.nanpercentile(a, 90, axis=axis))
    P_STD = prof_stat(np.nanstd)
    FF = np.nanpercentile(TT3[:, TRAIN_D, :].reshape(L, -1), 10, axis=1).astype("float32")

    def shift_days(k):
        out = np.full_like(TT3, np.nan)
        out[:, k:, :] = TT3[:, :-k, :]
        return out

    LAG1, LAG7, LAG14, LAG21 = shift_days(1), shift_days(7), shift_days(14), shift_days(21)
    LAGW = np.nanmean(np.stack([LAG7, LAG14, LAG21]), axis=0)

    UP = [[LIDX[x] for x in links[links.v == r.u]["링크아이디"] if x in LIDX] for r in links.itertuples()]
    DN = [[LIDX[x] for x in links[links.u == r.v]["링크아이디"] if x in LIDX] for r in links.itertuples()]

    def neigh_mean(idx_lists, A):
        out = np.full_like(A, np.nan)
        for i, nb in enumerate(idx_lists):
            if nb:
                out[i] = np.nanmean(A[nb], axis=0)
        return out

    UP7 = neigh_mean(UP, LAG7)
    DN7 = neigh_mean(DN, LAG7)

    FT = {k: i for i, k in enumerate(sorted(links["기능유형구분"].unique()))}
    S_len = links["거리"].values.astype("float32")
    S_lanes = links["차선수"].values.astype("float32")
    S_ft = links["기능유형구분"].map(FT).values.astype("float32")
    S_urban = (links["도심/외곽구분"] == "도심").values.astype("float32")
    S_sigdn = links["v"].map(nodes.has_signal).values.astype("float32")
    S_sigup = links["u"].map(nodes.has_signal).values.astype("float32")
    S_degdn = links["v"].map(nodes.deg_out).values.astype("float32")

    # 교차로 지연 δ (노드 고정효과 릿지 회귀) — 노트북 3.4절과 동일
    ex_rows = []
    for w in range(7):
        for h in range(24):
            e = P_MEAN[:, w, h] - FF
            m = np.isfinite(e)
            ex_rows.append(pd.DataFrame({"l": np.where(m)[0], "w": w, "h": h, "ex": e[m]}))
    ex = pd.concat(ex_rows, ignore_index=True)
    ex["peak"] = ex.h.isin([7, 8, 9, 17, 18, 19]).astype(int)
    ex["node"] = links["v"].values[ex.l]
    cov = np.c_[S_len[ex.l] / 1000, S_lanes[ex.l], S_urban[ex.l], np.eye(len(FT))[S_ft[ex.l].astype(int)]].astype("float32")
    rr0 = np.arange(len(ex))
    hw = sparse.csr_matrix((np.ones(len(ex), "float32"), (rr0, (ex.w * 24 + ex.h).values)), shape=(len(ex), 168))
    sig_nodes = sorted(set(ex.node[nodes.has_signal.reindex(ex.node).values == 1]))
    nidx = {n: i for i, n in enumerate(sig_nodes)}
    col = ex.node.map(nidx).fillna(-1).astype(int).values
    m = col >= 0
    rr = np.arange(len(ex))
    Z = sparse.hstack([
        sparse.csr_matrix((np.ones(m.sum()), (rr[m], col[m])), shape=(len(ex), len(sig_nodes))),
        sparse.csr_matrix((ex.peak.values[m].astype(float), (rr[m], col[m])), shape=(len(ex), len(sig_nodes))),
    ])
    X5 = sparse.hstack([sparse.csr_matrix(cov), hw, Z]).tocsr()
    reg5 = Ridge(alpha=5.0).fit(X5, ex.ex.values)
    k5 = cov.shape[1] + hw.shape[1]
    NODE_DELAY = pd.DataFrame({
        "node": sig_nodes,
        "delay_off": reg5.coef_[k5:k5 + len(sig_nodes)],
        "delay_peak_extra": reg5.coef_[k5 + len(sig_nodes):],
    })
    NODE_DELAY["delay_peak"] = NODE_DELAY.delay_off + NODE_DELAY.delay_peak_extra
    dmap_off = NODE_DELAY.set_index("node").delay_off
    dmap_pk = NODE_DELAY.set_index("node").delay_peak
    S_ddn_off = links["v"].map(dmap_off).fillna(0).values.astype("float32")
    S_ddn_pk = links["v"].map(dmap_pk).fillna(0).values.astype("float32")
    log("교차로 지연 추정 완료: 신호노드", len(sig_nodes))

    FEATS = ["hour", "dow", "is_weekend", "is_peak", "length", "lanes", "ftype", "urban", "ff",
             "sig_down", "sig_up", "deg_down", "delay_down_off", "delay_down_peak",
             "bl", "bp90", "bsd", "lag1", "lag7", "lag14", "lagw", "up7", "dn7"]

    def build_matrix(date_mask):
        didx = np.where(date_mask)[0]
        nd = len(didx)
        n = L * nd * 24
        li_ = np.repeat(np.arange(L, dtype=np.int32), nd * 24)
        di_ = np.tile(np.repeat(didx.astype(np.int32), 24), L)
        hi_ = np.tile(np.arange(24, dtype=np.int32), L * nd)
        w_ = DOW[di_]
        X = np.empty((n, len(FEATS)), "float32")
        bl = P_MEAN[li_, w_, hi_]

        def lagf(A):
            x = A[li_, di_, hi_]
            return np.where(np.isfinite(x), x, bl)

        src = {
            "hour": lambda: hi_, "dow": lambda: w_, "is_weekend": lambda: (w_ >= 5), "is_peak": lambda: np.isin(hi_, [7, 8, 9, 17, 18, 19]),
            "length": lambda: S_len[li_], "lanes": lambda: S_lanes[li_], "ftype": lambda: S_ft[li_], "urban": lambda: S_urban[li_], "ff": lambda: FF[li_],
            "sig_down": lambda: S_sigdn[li_], "sig_up": lambda: S_sigup[li_], "deg_down": lambda: S_degdn[li_],
            "delay_down_off": lambda: S_ddn_off[li_], "delay_down_peak": lambda: S_ddn_pk[li_],
            "bl": lambda: bl, "bp90": lambda: P_P90[li_, w_, hi_], "bsd": lambda: P_STD[li_, w_, hi_],
            "lag1": lambda: lagf(LAG1), "lag7": lambda: lagf(LAG7), "lag14": lambda: lagf(LAG14), "lagw": lambda: lagf(LAGW),
            "up7": lambda: lagf(UP7), "dn7": lambda: lagf(DN7),
        }
        for j, f in enumerate(FEATS):
            X[:, j] = src[f]()
        y = TT3[li_, di_, hi_]
        ok_ = np.isfinite(y) & np.isfinite(bl) & np.isfinite(X[:, FEATS.index("bp90")])
        return X[ok_], y[ok_].astype("float32")

    TRAIN_MASK = TRAIN_D.copy()
    TRAIN_MASK[:21] = False  # lag21 확보 가능한 날부터
    Xtr, ytr = build_matrix(TRAIN_MASK)
    log("학습 행", len(ytr), "피처", Xtr.shape[1])

    # ---------------------------------------------------
    # 3. LightGBM 학습 — 평균(mean) + P90(quantile) 두 모델
    # ---------------------------------------------------
    lgb_params = dict(
        n_estimators=N_ESTIMATORS, learning_rate=0.03, num_leaves=127,
        min_child_samples=200, subsample=0.8, subsample_freq=1,
        colsample_bytree=0.8, random_state=0, verbose=-1,
    )
    model_mean = lgb.LGBMRegressor(objective="regression", **lgb_params)
    model_mean.fit(Xtr, ytr)
    log("LightGBM(mean) 학습 완료")

    model_p90 = lgb.LGBMRegressor(objective="quantile", alpha=Q, **lgb_params)
    model_p90.fit(Xtr, ytr)
    log("LightGBM(p90) 학습 완료")

    # ---------------------------------------------------
    # 4. 전체 (링크 × 요일 × 시간) 예측 테이블
    #    실시간 lag 대신 프로파일(bl)로 채워서 "정적" 예측 테이블을 만든다.
    # ---------------------------------------------------
    li_all = np.repeat(np.arange(L, dtype=np.int32), 7 * 24)
    w_all = np.tile(np.repeat(np.arange(7, dtype=np.int32), 24), L)
    h_all = np.tile(np.arange(24, dtype=np.int32), L * 7)
    bl_all = P_MEAN[li_all, w_all, h_all]
    bp90_all = P_P90[li_all, w_all, h_all]
    bsd_all = P_STD[li_all, w_all, h_all]
    bl_all = np.where(np.isfinite(bl_all), bl_all, FF[li_all])
    bp90_all = np.where(np.isfinite(bp90_all), bp90_all, FF[li_all])
    bsd_all = np.where(np.isfinite(bsd_all), bsd_all, 0)

    Xall = np.empty((len(li_all), len(FEATS)), "float32")
    src_all = {
        "hour": h_all, "dow": w_all, "is_weekend": (w_all >= 5), "is_peak": np.isin(h_all, [7, 8, 9, 17, 18, 19]),
        "length": S_len[li_all], "lanes": S_lanes[li_all], "ftype": S_ft[li_all], "urban": S_urban[li_all], "ff": FF[li_all],
        "sig_down": S_sigdn[li_all], "sig_up": S_sigup[li_all], "deg_down": S_degdn[li_all],
        "delay_down_off": S_ddn_off[li_all], "delay_down_peak": S_ddn_pk[li_all],
        "bl": bl_all, "bp90": bp90_all, "bsd": bsd_all,
        "lag1": bl_all, "lag7": bl_all, "lag14": bl_all, "lagw": bl_all, "up7": bl_all, "dn7": bl_all,
    }
    for j, f in enumerate(FEATS):
        Xall[:, j] = src_all[f]

    pred_mean = model_mean.predict(Xall).astype("float32")
    pred_p90 = model_p90.predict(Xall).astype("float32")
    pred_mean = np.clip(pred_mean, 1.0, None)
    # p90은 정의상 평균 이상이어야 하므로 평균보다 작아지면 평균으로 올림
    pred_p90 = np.maximum(np.clip(pred_p90, 1.0, None), pred_mean)

    # ---------------------------------------------------
    # 5. 출력 파일 구성 — Next.js API가 정적 import로 읽는 graph.json
    # ---------------------------------------------------
    nodes_out = nodes.reset_index().rename(columns={"nid": "node"})
    nodes_json = {
        str(r.node): [round(float(r.lon), 6), round(float(r.lat), 6), int(r.has_signal)]
        for r in nodes_out.itertuples()
    }
    log("nodes 저장", len(nodes_json), "개")

    # li_all/w_all/h_all은 L*7*24 그리드를 (link, dow, hour) 순서로 순회하므로
    # pred_mean/pred_p90을 그대로 (L, 168) 형태로 reshape하면 인덱스가 일치한다.
    finite_all = np.isfinite(pred_mean) & np.isfinite(pred_p90)
    mean_grid = pred_mean.reshape(L, 7 * 24)
    p90_grid = pred_p90.reshape(L, 7 * 24)
    finite_grid = finite_all.reshape(L, 7 * 24)

    links_out = links.rename(columns={"링크아이디": "link", "도로명": "road", "거리": "length"})

    links_json: dict[str, dict] = {}
    for i, r in enumerate(links_out.itertuples(index=False)):
        lid = int(r.link)
        profile = [
            [round(float(mean_grid[i, s]), 1), round(float(p90_grid[i, s]), 1)] if finite_grid[i, s] else None
            for s in range(7 * 24)
        ]
        links_json[str(lid)] = {
            "road": str(r.road),
            "length": round(float(r.length), 1),
            "u": str(r.u),
            "v": str(r.v),
            "coords": [[round(float(x), 6), round(float(y), 6)] for x, y in geom.get(lid, [])],
            "profile": profile,
        }
    log("links 저장", len(links_json), "개")

    with open(os.path.join(OUT_DIR, "graph.json"), "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes_json, "links": links_json}, f, ensure_ascii=False, separators=(",", ":"))
    log("graph.json 저장 완료")


if __name__ == "__main__":
    main()
