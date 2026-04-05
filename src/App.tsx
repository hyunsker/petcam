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

/** 기기 라벨이 짧을 때 — iOS는 'Ultra Wide' 등으로 광각이 따로 뜨는 경우가 많음 */
function formatCameraOptionLabel(d: MediaDeviceInfo, index: number): string {
  const label = d.label?.trim()
  if (!label) {
    return `카메라 ${index + 1}`
  }
  const lower = label.toLowerCase()
  if (
    lower.includes('ultra') ||
    lower.includes('0.5') ||
    label.includes('광각') ||
    label.includes('울트라')
  ) {
    return `${label} (넓게 · 0.5x 후보)`
  }
  return label
}

function isFrontCameraLabel(label: string): boolean {
  const l = label.toLowerCase()
  return (
    l.includes('front') ||
    l.includes('face') ||
    l.includes('selfie') ||
    l.includes('user') ||
    label.includes('전면') ||
    label.includes('셀피')
  )
}

function pickFrontDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const found = devices.find((d) => d.label && isFrontCameraLabel(d.label))
  if (found) return found
  if (devices.length === 2 && devices.every((d) => !d.label)) {
    return devices[0]
  }
  return undefined
}

/** 기본 후면(보통 와이드). 라벨 없으면 두 번째 카메라 등 */
function pickBackDefaultDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const notFront = devices.filter((d) => !(d.label && isFrontCameraLabel(d.label)))
  if (notFront.length === 0) return undefined
  const primary = notFront.find((d) => {
    if (!d.label) return false
    const l = d.label.toLowerCase()
    const isBack =
      l.includes('back') ||
      l.includes('rear') ||
      l.includes('environment') ||
      d.label.includes('후면')
    const isUltra =
      l.includes('ultra') || d.label.includes('광각') || l.includes('0.5')
    return isBack && !isUltra
  })
  if (primary) return primary
  if (devices.length === 2 && devices.every((d) => !d.label)) {
    return devices[1]
  }
  return notFront[0]
}

export default function App() {
  const urlRole = useUrlRole()
  const [role, setRole] = useState<Role>(() => urlRole)
  const [displayName, setDisplayName] = useState('')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState<string>('')

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
    setConnecting(false)
    setVideoInputs([])
    setSelectedCameraId('')
  }, [])

  const refreshVideoInputs = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setVideoInputs(list.filter((d) => d.kind === 'videoinput'))
    } catch {
      setVideoInputs([])
    }
  }, [])

  const handleCameraChange = useCallback(
    async (deviceId: string) => {
      const room = roomRef.current
      if (!room || !deviceId) return
      try {
        await room.switchActiveDevice('videoinput', deviceId)
        setSelectedCameraId(deviceId)
        const v = localVideoRef.current
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera)
        if (camPub?.track && v) {
          camPub.track.attach(v)
          void v.play().catch(() => {})
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [],
  )

  const switchToFacing = useCallback(
    (facing: 'front' | 'back') => {
      const device =
        facing === 'front' ? pickFrontDevice(videoInputs) : pickBackDefaultDevice(videoInputs)
      if (device) {
        setError(null)
        void handleCameraChange(device.deviceId)
        return
      }
      setError(
        facing === 'front'
          ? '전면 카메라를 찾지 못했어요. 위에서 「새로고침」 후 다시 눌러 주세요.'
          : '후면 카메라를 찾지 못했어요. 위에서 「새로고침」 후 다시 눌러 주세요.',
      )
    },
    [videoInputs, handleCameraChange],
  )

  const connect = useCallback(async () => {
    setError(null)
    setConnecting(true)
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
        setStatus('카메라 준비됨')
      } else {
        setStatus('시청 준비됨')
      }

      /** ref(비디오 영역)는 `connected === true` 일 때만 DOM에 있음 → 먼저 화면 전환 */
      setConnected(true)
    } catch (e) {
      if (r) await r.disconnect()
      roomRef.current = null
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
      setConnected(false)
    } finally {
      setConnecting(false)
    }
  }, [displayName, identity, role])

  /** 연결 후 DOM이 생긴 뒤 트랙 붙이기 (이전 버그: ref 없이 return 해서 화면이 안 바뀜) */
  useEffect(() => {
    if (!connected) return
    const r = roomRef.current
    if (!r) return

    const remoteContainer = remoteWrapRef.current
    if (!remoteContainer) return

    const attachRemote = (track: Track) => {
      if (track.kind !== Track.Kind.Video) return
      const el = track.attach()
      if (el instanceof HTMLVideoElement) {
        el.playsInline = true
        el.muted = false
        void el.play().catch(() => {
          /* iOS는 제스처 후 재생될 수 있음 */
        })
      }
      el.className = 'remote-video-el'
      remoteContainer.appendChild(el)
    }

    const onTrackSubscribed = (track: Track) => {
      attachRemote(track)
    }
    const onTrackUnsubscribed = (track: Track) => {
      track.detach()
    }

    r.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        if (pub.track && pub.kind === Track.Kind.Video) {
          attachRemote(pub.track)
        }
      })
    })

    r.on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    r.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)

    const onLocalPublished = () => {
      const v = localVideoRef.current
      if (!v) return
      const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera)
      if (camPub?.track) {
        camPub.track.attach(v)
        void v.play().catch(() => {})
      }
    }

    if (role === 'publish') {
      r.on(RoomEvent.LocalTrackPublished, onLocalPublished)
      onLocalPublished()
      setStatus('카메라 송출 중')
    } else {
      setStatus('시청 중 — 송출 기기가 켜지면 여기에 보여요')
    }

    const gridEl = remoteContainer

    return () => {
      r.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
      r.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      r.off(RoomEvent.LocalTrackPublished, onLocalPublished)
      gridEl.innerHTML = ''
    }
  }, [connected, role])

  /** 송출 중: 사용 가능한 카메라 목록 (광각/울트라와이드는 기기마다 별 줄로 나옴) */
  useEffect(() => {
    if (!connected || role !== 'publish') {
      setVideoInputs([])
      setSelectedCameraId('')
      return
    }
    void refreshVideoInputs()
    const t = window.setTimeout(() => void refreshVideoInputs(), 600)
    const onDeviceChange = () => {
      void refreshVideoInputs()
    }
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => {
      window.clearTimeout(t)
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
    }
  }, [connected, role, refreshVideoInputs])

  /** 목록이 바뀌면 현재 선택 값을 룸 상태와 맞춤 */
  useEffect(() => {
    if (!connected || role !== 'publish' || videoInputs.length === 0) return
    const room = roomRef.current
    if (!room) return
    const active = room.getActiveDevice('videoinput')
    const found = active && videoInputs.some((d) => d.deviceId === active)
    if (found && active) {
      setSelectedCameraId(active)
    } else {
      setSelectedCameraId(videoInputs[0].deviceId)
    }
  }, [connected, role, videoInputs])

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

          <button
            type="button"
            className="btn primary"
            disabled={connecting}
            onClick={() => void connect()}
          >
            {connecting ? '연결 중…' : '연결할래요'}
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
            <>
              <div className="camera-picker">
                <label className="camera-picker-label" htmlFor="camera-device">
                  카메라
                </label>
                <div className="camera-picker-row">
                  <select
                    id="camera-device"
                    className="camera-select"
                    value={selectedCameraId}
                    onChange={(e) => void handleCameraChange(e.target.value)}
                  >
                    {videoInputs.length === 0 ? (
                      <option value="">목록 불러오는 중…</option>
                    ) : (
                      videoInputs.map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {formatCameraOptionLabel(d, i)}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    className="btn ghost btn-small"
                    onClick={() => void refreshVideoInputs()}
                  >
                    새로고침
                  </button>
                </div>
                <div className="facing-row">
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    onClick={() => switchToFacing('front')}
                  >
                    전면
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    onClick={() => switchToFacing('back')}
                  >
                    후면
                  </button>
                </div>
                <p className="camera-picker-hint">
                  <strong>전면 / 후면</strong> 버튼으로 셀카·후면을 바꿀 수 있어요. 세부 렌즈는
                  위 목록에서 고르세요. 아이폰·아이패드는 &quot;Ultra Wide&quot; 등으로 0.5x가 따로
                  보일 수 있어요 — 안 보이면 새로고침을 눌러 보세요.
                </p>
              </div>
              <div className="local-wrap">
                <span className="badge">내 화면 (이렇게 보여요)</span>
                <video ref={localVideoRef} className="local-video" playsInline muted />
              </div>
            </>
          )}

          {role === 'view' && (
            <p className="viewer-hint">아래는 태블릿 송출 화면이에요</p>
          )}

          <div className="remote-grid" ref={remoteWrapRef} />
          {role === 'view' && (
            <p className="viewer-empty-hint">
              영상이 없으면 태블릿에서 먼저 송출을 켜 주세요.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
