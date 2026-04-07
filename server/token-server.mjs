import { config as loadEnv } from 'dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { AccessToken, TrackSource } from 'livekit-server-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
// 실행 위치(cwd)와 관계없이 프로젝트 루트의 .env 를 읽음
loadEnv({ path: join(projectRoot, '.env') })
loadEnv({ path: join(projectRoot, '.env.local'), override: true })

const PORT = Number(process.env.TOKEN_SERVER_PORT || 8787)

const apiKey = process.env.LIVEKIT_API_KEY
const apiSecret = process.env.LIVEKIT_API_SECRET
const wsUrl = process.env.LIVEKIT_URL

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url === '/api/token') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  if (req.method !== 'POST' || req.url !== '/api/token') {
    sendJson(res, 404, { error: 'not_found' })
    return
  }

  let raw = ''
  for await (const chunk of req) {
    raw += chunk
  }

  let body
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { error: 'invalid_json' })
    return
  }

  const room = typeof body.room === 'string' ? body.room.trim() : ''
  const identity =
    typeof body.identity === 'string' && body.identity.trim()
      ? body.identity.trim()
      : `user-${Math.random().toString(36).slice(2, 10)}`
  const role = body.role === 'publish' ? 'publish' : 'view'
  const name = typeof body.name === 'string' ? body.name.trim() : undefined

  if (!room || room.length > 128) {
    sendJson(res, 400, { error: 'invalid_room' })
    return
  }

  if (!apiKey || !apiSecret || !wsUrl) {
    sendJson(res, 500, {
      error: 'server_misconfigured',
      hint:
        'pet-cam-web 폴더에 .env 파일을 만들고 LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET 을 넣은 뒤 터미널에서 npm run dev 를 다시 실행하세요.',
      missing: {
        LIVEKIT_URL: !wsUrl,
        LIVEKIT_API_KEY: !apiKey,
        LIVEKIT_API_SECRET: !apiSecret,
      },
    })
    return
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: name || (role === 'publish' ? '송출' : '시청'),
    ttl: '12h',
  })

  if (role === 'publish') {
    at.addGrant({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
    })
  } else {
    at.addGrant({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: true,
    })
  }

  const token = await at.toJwt()
  sendJson(res, 200, { token, url: wsUrl })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[token-server] http://127.0.0.1:${PORT}/api/token`)
  console.log(`[token-server] .env 경로: ${join(projectRoot, '.env')}`)
  if (!apiKey || !apiSecret || !wsUrl) {
    console.warn(
      '[token-server] 경고: LIVEKIT_* 환경 변수가 비어 있습니다. .env 를 확인하세요.',
    )
  } else {
    console.log('[token-server] LIVEKIT 설정 로드됨 (키 값은 출력하지 않음)')
  }
})
