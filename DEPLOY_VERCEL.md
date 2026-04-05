# Vercel에 올리기 (아이패드·태블릿에서 접속)

맥에서 `npm run dev` 없이 **인터넷 주소**로 접속하려면 아래 순서대로 하면 됩니다.

---

## 준비물

- GitHub 계정 (없으면 [github.com](https://github.com) 에서 무료 가입)
- LiveKit에서 받은 세 값: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- 이 프로젝트 폴더: `pet-cam-web`

---

## 1단계: GitHub에 저장소 만들기

1. 브라우저에서 [github.com](https://github.com) 로그인
2. 오른쪽 위 **+** → **New repository**
3. **Repository name**: 예) `pet-cam-web`
4. **Public** 선택 (무료로 Vercel 연동하기 편함)
5. **Create repository** 클릭  
   → 빈 저장소 페이지가 나오고, 터미널에 치라는 명령이 보임

---

## 2단계: 맥에서 코드 푸시하기

터미널을 연 다음 **한 줄씩** 실행합니다. (이메일/이름은 본인 것으로)

```bash
cd "/Users/hyunsker/개인 작업/pet-cam-web"
```

처음이면 Git 초기화:

```bash
git init
git add .
git commit -m "Initial pet-cam-web"
git branch -M main
```

GitHub 페이지에 나온 주소로 연결 (아래 `YOURNAME`/`pet-cam-web` 은 본인 저장소에 맞게):

```bash
git remote add origin https://github.com/YOURNAME/pet-cam-web.git
git push -u origin main
```

- 로그인 창이 뜨면 GitHub 계정으로 허용  
- `git` 이 없다고 나오면: Xcode Command Line Tools 설치 또는 `brew install git`

---

## 3단계: Vercel 가입

1. [vercel.com](https://vercel.com) 접속  
2. **Sign Up** → **Continue with GitHub**  
3. GitHub 로그인 후, Vercel이 저장소를 읽어도 되는지 **Authorize** 허용

---

## 4단계: 프로젝트 연결·첫 배포

1. Vercel 대시보드에서 **Add New…** → **Project**  
2. **Import** 할 저장소 목록에서 `pet-cam-web` 선택  
3. 설정 화면에서 대부분 **그대로** 두면 됩니다.

   - **Framework Preset**: Vite (자동 인식되면 그대로)  
   - **Build Command**: `npm run build`  
   - **Output Directory**: `dist`  
   - **Root Directory**: 비어 있음 (저장소 루트가 이 앱이면 그대로)

4. 아직 **Deploy** 누르지 말고, 다음 단계에서 환경 변수를 먼저 넣는 것을 권장합니다.  
   (먼저 배포했다면 나중에 환경 변수 추가 후 **Redeploy** 하면 됨)

---

## 5단계: 환경 변수 넣기 (필수)

배포 전/후 모두 **Project → Settings → Environment Variables** 에서:

| Name | Value |
|------|--------|
| `LIVEKIT_URL` | LiveKit 대시보드의 `wss://…` 주소 |
| `LIVEKIT_API_KEY` | API Key 문자열 |
| `LIVEKIT_API_SECRET` | API Secret 문자열 |

- **Environment**: Production (필요하면 Preview, Development 도 같은 값 추가)  
- 각 줄 **Save** 후 저장

이 세 개가 없으면 브라우저에서 **연결** 시 토큰 오류가 납니다.

---

## 6단계: 배포 / 재배포

1. **Deployments** 탭으로 이동  
2. 맨 위 배포 오른쪽 **⋯** → **Redeploy** (환경 변수를 방금 넣었다면 필수에 가깝습니다)

성공하면 **Visit** 또는 도메인 링크가 보입니다. 예:

`https://pet-cam-web-xxxx.vercel.app`

이 주소가 **집 밖에서도** 쓰는 주소입니다.

---

## 7단계: 아이패드·태블릿에서 열기

1. **Safari**(아이패드) 또는 **Chrome**(안드로이드 태블릿) 실행  
2. 주소창에 위 **Vercel 주소** 전체 붙여넣기  
3. **역할** 선택 → **연결할래요**  
4. 카메라 권한 **허용** (송출 기기만)

### 홈 화면에 아이콘으로 두기

- **아이패드 Safari**: 공유 아이콘 → **홈 화면에 추가**  
- **Chrome**: 메뉴 → **홈 화면에 추가** 또는 **앱 설치**

---

## 자주 막히는 것

| 증상 | 확인 |
|------|------|
| 빌드 실패 | 로컬에서 `npm run build` 가 되는지 먼저 확인 |
| 연결 시 LIVEKIT 오류 | Vercel 환경 변수 3개 이름·값, **Redeploy** 여부 |
| 카메라 안 뜸 | **https** 주소인지 (Vercel은 기본 https), 브라우저 권한 |
| API 404 | 이 프로젝트 루트에 `api/token.ts` 가 있는지 (저장소 구조) |

---

## 요약

1. GitHub에 `pet-cam-web` 푸시  
2. Vercel에서 GitHub 연동 → 프로젝트 Import  
3. 환경 변수 3개 설정 → Redeploy  
4. 나온 `https://….vercel.app` 을 태블릿·폰 브라우저에 입력  

이후 맥을 끄고 있어도, **그 주소만 알면** 아이패드에서 열 수 있습니다.
