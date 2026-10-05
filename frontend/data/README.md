# frontend/data/

`model/train.py`(GitHub Actions)가 생성하는 `graph.json`이 여기에 저장됩니다.
`public/` 밑이 아니라 여기 두는 이유는, `public/`의 파일은 정적 자산으로
브라우저에 그대로 노출되기 때문입니다. `frontend/app/lib/graph.ts`가 이 파일을
빌드 타임에 정적 import로 읽어 Next.js API 라우트(`app/api/route`,
`app/api/nodes`)의 서버 전용 번들에 포함시키므로, 클라이언트로는 내려가지
않습니다.

스키마:
```json
{
  "nodes": { "<node>": [lon, lat, has_signal], ... },
  "links": {
    "<linkId>": {
      "road": "...", "length": 123.4, "u": "<node>", "v": "<node>",
      "coords": [[lon, lat], ...],
      "profile": [ [mean, p90] | null, ... ]  // 168개, idx = dow*24+hour, 초 단위
    }
  }
}
```

지금 들어있는 `graph.json`은 A-B-C(직선, 신호 1개, 느림) / A-D-C(우회, 신호 없음,
빠름) 구조의 더미 테스트 그래프입니다. GitHub Actions를 1회 수동 실행하면
실제 데이터로 덮어씌워집니다.
