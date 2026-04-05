import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Room, RoomEvent, Track } from 'livekit-client'
import './App.css'

const STORAGE_ID = 'pet-cam-identity'

/** LiveKit 방 이름 (고정) */
const ROOM_NAME = '단이집'

function getOrCreateIdentity(): string {
  try {
    let id = localStorage.getItem(STORAGE_ID)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(STORAGE_ID, id)
    }
    return id
  } catch {
    return `u-${Math.random().toString(36).slice(2, 12)}`
  }
}

type Role = 'publish' | 'view'

async function fetchToken(body: {
  room: string
  identity: string
  role: Role
  name?: string
}): Promise<{ token: string; url: string }> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    token?: string
    url?: string
    error?: string
    hint?: string
  }
  if (!res.ok) {
    throw new Error(data.hint || data.error || `HTTP ${res.status}`)
  }
  if (!data.token || !data.url) {
    throw new Error('invalid_token_response')
  }
  return { token: data.token, url: data.url }
}

function useUrlRole(): Role {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search)
    return p.get('role') === 'publish' ? 'publish' : 'view'
  }, [])
}

export default function App() {
  const urlRole = useUrlRole()
  const [role, setRole] = useState<Role>(() => urlRole)
  const [displayName, setDisplayName] = useState('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')

  const roomRef = useRef<Room | null>(null)
  const remoteWrapRef = useRef<HTMLDivElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)

  const identity = useMemo(() => getOrCreateIdentity(), [])

  const disconnect = useCallback(async () => {
    const r = roomRef.current
    roomRef.current = null
    if (r) {
      await r.disconnect()
    }
    if (remoteWrapRef.current) {
      remoteWrapRef.current.innerHTML = ''
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    setConnected(false)
    setStatus('')
  }, [])

  const connect = useCallback(async () => {
    setError(null)
    setStatus('토큰 요청 중…')
    let r: Room | null = null
    try {
      const { token, url } = await fetchToken({
        room: ROOM_NAME,
        identity,
        role,
        name: displayName.trim() || undefined,
      })
      r = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = r

      r.on(RoomEvent.Disconnected, () => {
        setConnected(false)
        setStatus('연결 종료')
      })

      setStatus('룸 연결 중…')
      await r.connect(url, token)

      if (role === 'publish') {
        await r.localParticipant.setMicrophoneEnabled(false)
        await r.localParticipant.setCameraEnabled(true)
        setStatus('카메라 송출 중')
      } else {
        setStatus('시청 중')
      }

      const remoteContainer = remoteWrapRef.current
      if (!remoteContainer) return

      const attachRemote = (track: Track) => {
        if (track.kind !== Track.Kind.Video) return
        const el = track.attach()
        if (el instanceof HTMLVideoElement) {
          el.playsInline = true
        }
        el.className = 'remote-video-el'
        remoteContainer.appendChild(el)
      }

      r.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (pub.track && pub.kind === Track.Kind.Video) {
            attachRemote(pub.track)
          }
        })
      })

      r.on(RoomEvent.TrackSubscribed, (track) => {
        attachRemote(track)
      })

      r.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach()
      })

      if (role === 'publish') {
        r.on(RoomEvent.LocalTrackPublished, (pub) => {
          if (pub.kind !== Track.Kind.Video || !localVideoRef.current) return
          const t = pub.track
          if (t) t.attach(localVideoRef.current)
        })
        const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera)
        if (camPub?.track && localVideoRef.current) {
          camPub.track.attach(localVideoRef.current)
        }
      }

      setConnected(true)
    } catch (e) {
      if (r) await r.disconnect()
      roomRef.current = null
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
    }
  }, [displayName, identity, role])

  useEffect(() => {
    return () => {
      void disconnect()
    }
  }, [disconnect])

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-emoji" aria-hidden>
            🐾
          </span>
          <h1>Pet Cam</h1>
        </div>
        <p className="tagline">둘만의 작은 홈캠</p>
      </header>

      {!connected ? (
        <section className="form form-card">
          <fieldset className="role-field">
            <legend>역할</legend>
            <label>
              <input
                type="radio"
                name="role"
                checked={role === 'publish'}
                onChange={() => setRole('publish')}
              />{' '}
              송출 (태블릿 · 카메라)
            </label>
            <label>
              <input
                type="radio"
                name="role"
                checked={role === 'view'}
                onChange={() => setRole('view')}
              />{' '}
              시청 (폰)
            </label>
          </fieldset>

          <label className="field">
            <span>표시 이름 (선택)</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="닉네임"
            />
          </label>

          <button type="button" className="btn primary" onClick={() => void connect()}>
            연결할래요
          </button>
          {error && (
            <div className="err-box">
              <p className="err">{error}</p>
              {(error.includes('LIVEKIT') || error.includes('.env')) && (
                <ol className="setup-steps">
                  <li>
                    <code>개인 작업/pet-cam-web/.env</code> 파일이 있는지 확인 (이
                    이름·위치 그대로)
                  </li>
                  <li>
                    LiveKit 대시보드에서 복사한 세 줄을 넣기:{' '}
                    <code>LIVEKIT_URL</code>, <code>LIVEKIT_API_KEY</code>,{' '}
                    <code>LIVEKIT_API_SECRET</code>
                  </li>
                  <li>저장 후 터미널에서 dev 서버를 끄고(Ctrl+C) 다시 실행</li>
                </ol>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="session">
          <div className="session-card">
            <div className="session-bar">
              <span className="pill">{role === 'publish' ? '송출 중' : '시청 중'}</span>
              <span className="room-label">방 · {ROOM_NAME}</span>
              <span className="status">{status}</span>
              <button type="button" className="btn ghost" onClick={() => void disconnect()}>
                나가기
              </button>
            </div>
          </div>

          {role === 'publish' && (
            <div className="local-wrap">
              <span className="badge">여기 보이는 중</span>
              <video ref={localVideoRef} className="local-video" playsInline muted />
            </div>
          )}

          <div className="remote-grid" ref={remoteWrapRef} />
        </section>
      )}
    </div>
  )
}
