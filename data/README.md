# data/ 폴더

GitHub Actions가 LightGBM을 학습할 때 사용하는 원본 데이터를 여기에 둡니다.

필요한 파일:
- `speed_05.xlsx` ~ `speed_08.xlsx` (또는 기간에 맞는 속도 데이터, 여러 개 가능)
- `vertex.xlsx`
- `signals.csv`

파일 용량이 크면(수십 MB 이상) 일반 git push가 느려지거나 GitHub 용량 제한에
걸릴 수 있습니다. 그런 경우 [Git LFS](https://git-lfs.com/)를 쓰거나,
별도 스토리지(S3 등)에 올려두고 워크플로 시작 부분에서 다운로드하도록
`.github/workflows/retrain.yml`을 수정하세요.
