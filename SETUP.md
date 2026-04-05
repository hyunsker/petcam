# Pet Cam — 환경 설정 (당신이 할 일)

## 1. 로컬에서 `npm run dev` 로 테스트할 때

1. 이 폴더(`pet-cam-web`) **바로 안**에 `.env` 파일을 만든다.
2. [LiveKit Cloud](https://cloud.livekit.io) → 프로젝트 → API 키에서 아래 세 줄을 그대로 넣는다.

```env
LIVEKIT_URL=wss://....livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

3. 파일을 저장한다.
4. 터미널에서 dev 서버를 **한 번 끄고(Ctrl+C)** `npm run dev` 를 다시 실행한다.
5. 브라우저에서 안내된 주소(예: `http://localhost:5174`)로 접속한다.

`.env` 는 Git에 올리지 말 것(이미 `.gitignore`에 포함).

## 2. Vercel 등에 배포해서 쓸 때

맥의 `.env` 는 배포 서버로 자동 전송되지 않는다. Vercel 프로젝트 **Settings → Environment Variables**에 위 세 이름으로 각각 넣고, **Redeploy** 한다.

## 3. 그래도 `LIVEKIT_* 필요` 가 뜨면

- `.env` 가 **`pet-cam-web` 폴더 안**에 있는지 (상위 폴더에 있으면 안 됨)
- 변수 이름 철자·대문자가 위와 같은지
- `LIVEKIT_URL` 이 `wss://` 로 시작하는지
- dev 서버를 **재시작**했는지

터미널에 `[token-server] LIVEKIT 설정 로드됨` 이 보이면 로컬 설정은 정상이다.
