import { useState, useEffect, useRef, useCallback } from "react";

// ─── Audio Engine (Safari-safe) ──────────────────────────────────
const AudioEngine = (() => {
  let ctx = null;
  const buffers = { inhale: null, exhale: null };
  const mediaElements = { inhale: null, exhale: null };
  const sampleGains = { inhale: 1, exhale: 1 };
  let loadPromise = null;
  let breathVolume = 1;
  const TARGET_PEAK = 0.82;
  const MAX_AUTO_GAIN = 10;

  const getCtx = () => {
    try {
      if (!ctx || ctx.state === "closed") {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (ctx.state === "suspended") ctx.resume();
    } catch (e) {}
    return ctx;
  };

  const getPeakLevel = (audioBuffer) => {
    let peak = 0;
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      const channelData = audioBuffer.getChannelData(i);
      for (let j = 0; j < channelData.length; j++) {
        const value = Math.abs(channelData[j]);
        if (value > peak) peak = value;
      }
    }
    return peak;
  };

  const getAutoGain = (audioBuffer) => {
    const peak = getPeakLevel(audioBuffer);
    if (peak < 0.0001) return 1;
    return Math.min(MAX_AUTO_GAIN, TARGET_PEAK / peak);
  };

  const loadSample = async (name, path) => {
    try {
      const res = await fetch(path);
      if (!res.ok) return false;
      const arrayBuf = await res.arrayBuffer();
      const c = getCtx();
      if (!c) return false;
      const decoded = await c.decodeAudioData(arrayBuf);
      buffers[name] = decoded;
      sampleGains[name] = getAutoGain(decoded);
      return true;
    } catch (e) {}
    return false;
  };

  const createMediaElement = (name, path) => {
    if (mediaElements[name]) return mediaElements[name];
    const el = new Audio(path);
    el.preload = "auto";
    el.playsInline = true;
    mediaElements[name] = el;
    return el;
  };

  const primeMediaElements = async () => {
    const names = ["inhale", "exhale"];
    await Promise.all(
      names.map(async (name) => {
        const el = mediaElements[name];
        if (!el) return;
        try {
          el.muted = true;
          el.volume = 0;
          await el.play();
          el.pause();
          el.currentTime = 0;
        } catch (e) {}
        el.muted = false;
        el.volume = 1;
      }),
    );
  };

  const playMediaSample = (name, vol = 1.0, onRejected) => {
    const el = mediaElements[name];
    if (!el) return false;
    try {
      el.pause();
      el.currentTime = 0;
      const adjustedVol = vol * breathVolume * (sampleGains[name] || 1);
      el.volume = Math.min(1, Math.max(0, adjustedVol));
      const playPromise = el.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          if (onRejected) onRejected();
        });
      }
      return true;
    } catch (e) {
      return false;
    }
  };

  const shouldPreferMediaPlayback = () => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const iOSDevice = /iPad|iPhone|iPod/.test(ua);
    const iPadOSDesktopUA = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return iOSDevice || iPadOSDesktopUA;
  };

  const ensureSamplesLoaded = async () => {
    const base = import.meta.env.BASE_URL;
    createMediaElement("inhale", `${base}audio/inhale.mp3`);
    createMediaElement("exhale", `${base}audio/exhale.mp3`);
    if (buffers.inhale && buffers.exhale) return;
    if (!loadPromise) {
      loadPromise = Promise.all([
        loadSample("inhale", `${base}audio/inhale.mp3`),
        loadSample("exhale", `${base}audio/exhale.mp3`),
      ]).finally(() => {
        if (!buffers.inhale || !buffers.exhale) loadPromise = null;
      });
    }
    await loadPromise;
  };

  const playWebAudioSample = (name, vol = 1.0) => {
    const c = getCtx();
    if (!c || !buffers[name]) return false;
    try {
      const src = c.createBufferSource();
      const gain = c.createGain();
      src.buffer = buffers[name];
      const adjustedVol = Math.min(vol * breathVolume * (sampleGains[name] || 1), MAX_AUTO_GAIN);
      gain.gain.setValueAtTime(adjustedVol, c.currentTime);
      src.connect(gain);
      gain.connect(c.destination);
      src.start(c.currentTime);
      return true;
    } catch (e) {
      return false;
    }
  };

  const playSample = (name, vol = 1.0) => {
    if (shouldPreferMediaPlayback()) {
      const mediaStarted = playMediaSample(name, vol, () => {
        playWebAudioSample(name, vol);
      });
      if (mediaStarted) return true;
      return playWebAudioSample(name, vol);
    }
    if (playWebAudioSample(name, vol)) return true;
    return playMediaSample(name, vol);
  };

  const unlock = async () => {
    try {
      const c = getCtx();
      if (!c) return;
      const buf = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
      if (c.state === "suspended") await c.resume();
      await ensureSamplesLoaded();
      await primeMediaElements();
    } catch (e) {
      return;
    }
  };

  // Bell with harmonics — produces a clear "ding" ring sound
  const playBell = (freq, vol = 0.55, delay = 0) => {
    const c = getCtx();
    if (!c) return;
    const partials = [
      { ratio: 1,    amp: 1.0,  decay: 2.2 },
      { ratio: 2.76, amp: 0.45, decay: 1.6 },
      { ratio: 5.40, amp: 0.20, decay: 1.1 },
      { ratio: 8.93, amp: 0.08, decay: 0.7 },
    ];
    partials.forEach(({ ratio, amp, decay }) => {
      try {
        const t = c.currentTime + delay;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq * ratio, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(vol * amp, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start(t);
        osc.stop(t + decay);
      } catch (e) {}
    });
  };

  const playTone = (freq, duration, type = "sine", vol = 0.35) => {
    const c = getCtx();
    if (!c) return;
    try {
      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + duration);
    } catch (e) {}
  };

  return {
    unlock,
    setBreathVolume: (value) => {
      breathVolume = Math.min(2.4, Math.max(0.25, value));
    },
    inhale: () => playSample("inhale", 1.2),
    exhale: () => playSample("exhale", 0.85),
    holdStart: () => playBell(432, 0.65),
    recoveryIn: () => playBell(528, 0.6),
    roundComplete: () => {
      playBell(440, 0.5, 0);
      playBell(554, 0.45, 0.35);
      playBell(659, 0.4, 0.7);
    },
    sessionComplete: () => {
      [440, 494, 554, 622, 740].forEach((f, i) => playBell(f, 0.4, i * 0.28));
    },
    tick: () => playTone(900, 0.07, "triangle", 0.15),
    countdownBeep: () => playBell(660, 0.4),
  };
})();

// ─── Storage helpers ─────────────────────────────────────────────
const STORAGE_KEY = "whm_breathing_data";

const loadData = async () => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const saveData = async (data) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
};

const todayStr = () => new Date().toISOString().slice(0, 10);

const calcStreak = (sessions) => {
  if (!sessions || sessions.length === 0) return 0;
  const dates = [...new Set(sessions.map((s) => s.date))].sort().reverse();
  const today = todayStr();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dates[0] !== today && dates[0] !== yesterday) return 0;
  let streak = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diff = (prev - curr) / 86400000;
    if (diff === 1) streak++;
    else break;
  }
  return streak;
};

// ─── Phases ──────────────────────────────────────────────────────
const PHASE = {
  SETUP: "setup",
  BREATHING: "breathing",
  RETENTION: "retention",
  RECOVERY: "recovery",
  ROUND_DONE: "round_done",
  COMPLETE: "complete",
};

const ACTIVE_PHASES = [PHASE.BREATHING, PHASE.RETENTION, PHASE.RECOVERY];
const BREATH_CYCLE_MS = 4000;
const EXHALE_CUE_DELAY_MS = 2000;

// ─── Formatters ──────────────────────────────────────────────────
const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
};

// ─── Main Component ──────────────────────────────────────────────
export default function WimHofBreathing() {
  const [appData, setAppData] = useState({ sessions: [] });
  const [loaded, setLoaded] = useState(false);
  const [rounds, setRounds] = useState(3);
  const [breathsPerRound, setBreathsPerRound] = useState(40);
  const [phase, setPhase] = useState(PHASE.SETUP);
  const [currentRound, setCurrentRound] = useState(0);
  const [breathCount, setBreathCount] = useState(0);
  const [isInhale, setIsInhale] = useState(true);
  const [retentionTime, setRetentionTime] = useState(0);
  const [recoveryCountdown, setRecoveryCountdown] = useState(15);
  const [roundRetentions, setRoundRetentions] = useState([]);
  const [sessionStart, setSessionStart] = useState(null);
  const [breathingAnim, setBreathingAnim] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [breathVolume, setBreathVolume] = useState(1);
  const [showVolumeControl, setShowVolumeControl] = useState(false);

  const intervalRef = useRef(null);
  const timeoutRef = useRef(null);
  const phaseRef = useRef(phase);
  const wakeLockRef = useRef(null);
  phaseRef.current = phase;
  const isActiveSession = ACTIVE_PHASES.includes(phase);

  useEffect(() => {
    loadData().then((d) => {
      if (d) setAppData(d);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    AudioEngine.setBreathVolume(breathVolume);
  }, [breathVolume]);

  useEffect(() => {
    if (!isActiveSession) {
      setShowVolumeControl(false);
    }
  }, [isActiveSession]);

  const requestWakeLock = useCallback(async () => {
    try {
      if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
      if (wakeLockRef.current) return;
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      wakeLockRef.current.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
    } catch (e) {}
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (!wakeLockRef.current) return;
      await wakeLockRef.current.release();
      wakeLockRef.current = null;
    } catch (e) {
      wakeLockRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isActiveSession) requestWakeLock();
    else releaseWakeLock();
  }, [isActiveSession, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && isActiveSession) {
        requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isActiveSession, requestWakeLock]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
    };
  }, [releaseWakeLock]);

  const clearTimers = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
  }, []);

  // ── Breathing phase logic ──
  const startBreathingPhase = useCallback(() => {
    setPhase(PHASE.BREATHING);
    setBreathCount(0);
    setIsInhale(true);
    setBreathingAnim(false);
    let count = 0;

    clearTimers();

    const breathCycle = () => {
      if (phaseRef.current !== PHASE.BREATHING) return;
      setIsInhale(true);
      setBreathingAnim(true);
      AudioEngine.inhale();

      timeoutRef.current = setTimeout(() => {
        if (phaseRef.current !== PHASE.BREATHING) return;
        setIsInhale(false);
        setBreathingAnim(false);
        AudioEngine.exhale();

        count++;
        setBreathCount(count);

        if (count >= breathsPerRound) {
          clearTimers();
          setTimeout(() => {
            setPhase(PHASE.RETENTION);
            setRetentionTime(0);
            AudioEngine.holdStart();
          }, 800);
        }
      }, EXHALE_CUE_DELAY_MS);
    };

    setTimeout(breathCycle, 300);
    intervalRef.current = setInterval(breathCycle, BREATH_CYCLE_MS);
  }, [breathsPerRound, clearTimers]);

  // ── Retention timer ──
  useEffect(() => {
    if (phase === PHASE.RETENTION) {
      clearTimers();
      intervalRef.current = setInterval(() => {
        setRetentionTime((t) => {
          if ((t + 1) % 60 === 0) AudioEngine.tick();
          return t + 1;
        });
      }, 1000);
    }
    return () => {
      if (phase === PHASE.RETENTION) clearTimers();
    };
  }, [phase, clearTimers]);

  // ── Recovery countdown ──
  useEffect(() => {
    if (phase === PHASE.RECOVERY) {
      setRecoveryCountdown(15);
      AudioEngine.recoveryIn();
      clearTimers();
      intervalRef.current = setInterval(() => {
        setRecoveryCountdown((c) => {
          if (c <= 1) {
            clearTimers();
            AudioEngine.roundComplete();
            setTimeout(() => setPhase(PHASE.ROUND_DONE), 300);
            return 0;
          }
          if (c <= 4) AudioEngine.countdownBeep();
          return c - 1;
        });
      }, 1000);
    }
    return () => {
      if (phase === PHASE.RECOVERY) clearTimers();
    };
  }, [phase, clearTimers]);

  // ── Start session ──
  const startSession = () => {
    AudioEngine.unlock().then(() => {
      setCurrentRound(1);
      setRoundRetentions([]);
      setSessionStart(Date.now());
      startBreathingPhase();
    });
  };

  // ── End retention (user taps) ──
  const endRetention = () => {
    if (phase !== PHASE.RETENTION) return;
    AudioEngine.unlock();
    clearTimers();
    setRoundRetentions((prev) => [...prev, retentionTime]);
    setPhase(PHASE.RECOVERY);
  };

  // ── Next round or complete ──
  const nextRound = () => {
    AudioEngine.unlock();
    if (currentRound >= rounds) {
      const duration = Math.round((Date.now() - sessionStart) / 1000);
      const sessionRecord = {
        date: todayStr(),
        rounds,
        breathsPerRound,
        retentions: roundRetentions,
        duration,
        timestamp: Date.now(),
      };
      const newData = { ...appData, sessions: [...appData.sessions, sessionRecord] };
      setAppData(newData);
      saveData(newData);
      AudioEngine.sessionComplete();
      setPhase(PHASE.COMPLETE);
    } else {
      setCurrentRound((r) => r + 1);
      startBreathingPhase();
    }
  };

  // ── Reset ──
  const resetToSetup = () => {
    clearTimers();
    setShowQuitConfirm(false);
    setPhase(PHASE.SETUP);
    setCurrentRound(0);
    setBreathCount(0);
    setRetentionTime(0);
    setRoundRetentions([]);
  };

  // ── Derived data ──
  const streak = calcStreak(appData.sessions);
  const todaySessions = appData.sessions.filter((s) => s.date === todayStr());
  const totalSessions = appData.sessions.length;

  if (!loaded) return null;

  return (
    <div style={styles.root}>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,300&family=Instrument+Serif&display=swap"
        rel="stylesheet"
      />
      <div style={styles.noiseOverlay} />

      {/* ─── SETUP SCREEN ─── */}
      {phase === PHASE.SETUP && (
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Breathe</h1>
            <p style={styles.subtitle}>Wim Hof Method</p>
          </div>

          <div style={styles.statsBanner}>
            <div style={styles.statItem}>
              <span style={styles.statNumber}>{streak}</span>
              <span style={styles.statLabel}>day streak</span>
            </div>
            <div style={styles.statDivider} />
            <div style={styles.statItem}>
              <span style={styles.statNumber}>{todaySessions.length}</span>
              <span style={styles.statLabel}>today</span>
            </div>
            <div style={styles.statDivider} />
            <div style={styles.statItem}>
              <span style={styles.statNumber}>{totalSessions}</span>
              <span style={styles.statLabel}>all time</span>
            </div>
          </div>

          <div style={styles.configSection}>
            <div style={styles.configRow}>
              <span style={styles.configLabel}>Rounds</span>
              <div style={styles.stepper}>
                <button
                  style={styles.stepBtn}
                  onClick={() => setRounds((r) => Math.max(1, r - 1))}
                >
                  −
                </button>
                <span style={styles.stepValue}>{rounds}</span>
                <button
                  style={styles.stepBtn}
                  onClick={() => setRounds((r) => Math.min(10, r + 1))}
                >
                  +
                </button>
              </div>
            </div>
            <div style={styles.configRow}>
              <span style={styles.configLabel}>Breaths per round</span>
              <div style={styles.stepper}>
                <button
                  style={styles.stepBtn}
                  onClick={() => setBreathsPerRound((b) => Math.max(20, b - 5))}
                >
                  −
                </button>
                <span style={styles.stepValue}>{breathsPerRound}</span>
                <button
                  style={styles.stepBtn}
                  onClick={() => setBreathsPerRound((b) => Math.min(60, b + 5))}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <button style={styles.startBtn} onClick={startSession}>
            Begin Session
          </button>

          {todaySessions.length > 0 && (
            <div style={styles.todaySection}>
              <h3 style={styles.todayTitle}>Today's Sessions</h3>
              {todaySessions.map((s, i) => (
                <div key={i} style={styles.sessionCard}>
                  <div style={styles.sessionCardRow}>
                    <span style={styles.sessionCardLabel}>
                      {s.rounds} rounds × {s.breathsPerRound} breaths
                    </span>
                    <span style={styles.sessionCardTime}>{fmtTime(s.duration)}</span>
                  </div>
                  {s.retentions && (
                    <div style={styles.retentionRow}>
                      {s.retentions.map((r, j) => (
                        <span key={j} style={styles.retentionPill}>
                          R{j + 1}: {fmtTime(r)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── BREATHING PHASE ─── */}
      {phase === PHASE.BREATHING && (
        <div style={styles.activeContainer}>
          <div style={styles.roundIndicator}>
            Round {currentRound} of {rounds}
          </div>

          <div style={styles.orbContainer}>
            <div
              style={{
                ...styles.orbOuter,
                transform: breathingAnim ? "scale(1)" : "scale(0.55)",
                opacity: breathingAnim ? 1 : 0.6,
                background: breathingAnim
                  ? "radial-gradient(circle, rgba(120,200,255,0.35) 0%, rgba(80,160,220,0.15) 50%, transparent 70%)"
                  : "radial-gradient(circle, rgba(120,200,255,0.15) 0%, rgba(80,160,220,0.05) 50%, transparent 70%)",
              }}
            />
            <div
              style={{
                ...styles.orbInner,
                transform: breathingAnim ? "scale(1)" : "scale(0.5)",
                opacity: breathingAnim ? 0.9 : 0.4,
              }}
            />
            <div style={styles.orbCenter}>
              <span style={styles.breathNum}>{breathCount}</span>
              <span style={styles.breathTotal}>/ {breathsPerRound}</span>
            </div>
          </div>

          <p style={styles.phaseLabel}>{isInhale ? "Breathe In" : "Breathe Out"}</p>
          <p style={styles.phaseHint}>Deep belly breaths, in through nose, out through mouth</p>
        </div>
      )}

      {/* ─── RETENTION PHASE ─── */}
      {phase === PHASE.RETENTION && (
        <div style={styles.activeContainer}>
          <div style={styles.roundIndicator}>
            Round {currentRound} of {rounds} — Retention
          </div>

          <div style={styles.orbContainer}>
            <div style={{ ...styles.orbOuter, transform: "scale(0.4)", opacity: 0.3 }} />
            <div
              style={{
                ...styles.orbInner,
                transform: "scale(0.45)",
                opacity: 0.35,
                background:
                  "radial-gradient(circle, rgba(255,180,100,0.6) 0%, rgba(255,140,60,0.3) 60%, transparent 80%)",
              }}
            />
            <div style={styles.orbCenter}>
              <span style={styles.retentionTimer}>{fmtTime(retentionTime)}</span>
            </div>
          </div>

          <p style={styles.phaseLabel}>Hold Your Breath</p>
          <button style={styles.tapBtn} onClick={endRetention}>
            Tap when you need to breathe
          </button>
        </div>
      )}

      {/* ─── RECOVERY PHASE ─── */}
      {phase === PHASE.RECOVERY && (
        <div style={styles.activeContainer}>
          <div style={styles.roundIndicator}>
            Round {currentRound} of {rounds} — Recovery
          </div>

          <div style={styles.orbContainer}>
            <div
              style={{
                ...styles.orbOuter,
                transform: "scale(0.85)",
                opacity: 0.7,
                background:
                  "radial-gradient(circle, rgba(100,220,180,0.3) 0%, rgba(60,180,140,0.12) 50%, transparent 70%)",
              }}
            />
            <div
              style={{
                ...styles.orbInner,
                transform: "scale(0.8)",
                opacity: 0.7,
                background:
                  "radial-gradient(circle, rgba(100,220,180,0.7) 0%, rgba(60,180,140,0.3) 60%, transparent 80%)",
              }}
            />
            <div style={styles.orbCenter}>
              <span style={styles.recoveryNum}>{recoveryCountdown}</span>
            </div>
          </div>

          <p style={styles.phaseLabel}>Breathe In & Hold</p>
          <p style={styles.phaseHint}>Take a deep recovery breath and hold for 15 seconds</p>
        </div>
      )}

      {/* ─── ROUND COMPLETE ─── */}
      {phase === PHASE.ROUND_DONE && (
        <div style={styles.activeContainer}>
          <div style={styles.roundIndicator}>Round {currentRound} Complete</div>

          <div style={styles.roundDoneStats}>
            <div style={styles.rdStatBig}>
              <span style={styles.rdStatValue}>
                {fmtTime(roundRetentions[roundRetentions.length - 1] || 0)}
              </span>
              <span style={styles.rdStatLabel}>breath hold</span>
            </div>
          </div>

          {roundRetentions.length > 1 && (
            <div style={styles.allRetentions}>
              {roundRetentions.map((r, i) => (
                <span key={i} style={styles.retentionPillLight}>
                  R{i + 1}: {fmtTime(r)}
                </span>
              ))}
            </div>
          )}

          <button style={styles.startBtn} onClick={nextRound}>
            {currentRound >= rounds ? "Finish Session" : "Next Round"}
          </button>
        </div>
      )}

      {/* ─── SESSION COMPLETE ─── */}
      {phase === PHASE.COMPLETE && (
        <div style={styles.container}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <p style={styles.completeEmoji}>✦</p>
            <h2 style={styles.completeTitle}>Session Complete</h2>
          </div>

          <div style={styles.completeSummary}>
            <div style={styles.csRow}>
              <span style={styles.csLabel}>Rounds</span>
              <span style={styles.csValue}>{rounds}</span>
            </div>
            <div style={styles.csRow}>
              <span style={styles.csLabel}>Breaths per round</span>
              <span style={styles.csValue}>{breathsPerRound}</span>
            </div>
            <div style={styles.csRow}>
              <span style={styles.csLabel}>Duration</span>
              <span style={styles.csValue}>
                {fmtTime(Math.round((Date.now() - sessionStart) / 1000))}
              </span>
            </div>
            <div style={{ ...styles.csDivider }} />
            <div style={styles.csRetentions}>
              <span style={styles.csLabel}>Retention Times</span>
              <div style={styles.retentionRow}>
                {roundRetentions.map((r, i) => (
                  <span key={i} style={styles.retentionPillLight}>
                    R{i + 1}: {fmtTime(r)}
                  </span>
                ))}
              </div>
            </div>
            {roundRetentions.length > 0 && (
              <div style={styles.csRow}>
                <span style={styles.csLabel}>Best hold</span>
                <span style={{ ...styles.csValue, color: "#78d6b5" }}>
                  {fmtTime(Math.max(...roundRetentions))}
                </span>
              </div>
            )}
          </div>

          <div style={{ ...styles.statsBanner, marginTop: 24 }}>
            <div style={styles.statItem}>
              <span style={styles.statNumber}>{calcStreak(appData.sessions)}</span>
              <span style={styles.statLabel}>day streak</span>
            </div>
            <div style={styles.statDivider} />
            <div style={styles.statItem}>
              <span style={styles.statNumber}>
                {appData.sessions.filter((s) => s.date === todayStr()).length}
              </span>
              <span style={styles.statLabel}>today</span>
            </div>
          </div>

          <button style={{ ...styles.startBtn, marginTop: 28 }} onClick={resetToSetup}>
            Done
          </button>
        </div>
      )}

      {/* Cancel button during active session */}
      {isActiveSession && (
        <button style={styles.cancelBtn} onClick={() => setShowQuitConfirm(true)}>
          ✕
        </button>
      )}

      {isActiveSession && (
        <div
          style={{
            ...styles.volumeDock,
            ...(showVolumeControl ? styles.volumeDockOpen : null),
          }}
        >
          <button
            style={styles.volumeHandle}
            onClick={() => setShowVolumeControl((v) => !v)}
            aria-label={showVolumeControl ? "Hide breath volume" : "Show breath volume"}
          >
            <span style={styles.volumeHandleText}>breath sound</span>
            <span style={styles.volumeHandleValue}>{Math.round(breathVolume * 100)}%</span>
          </button>
          <div
            style={{
              ...styles.volumePanel,
              ...(showVolumeControl ? styles.volumePanelOpen : styles.volumePanelClosed),
            }}
          >
            <input
              style={styles.volumeSlider}
              type="range"
              min="0.25"
              max="2.4"
              step="0.05"
              value={breathVolume}
              onChange={(e) => setBreathVolume(Number(e.target.value))}
              aria-label="Breath sound level"
            />
          </div>
        </div>
      )}

      {/* Quit confirmation overlay */}
      {showQuitConfirm && (
        <div style={styles.quitOverlay}>
          <div style={styles.quitCard}>
            <p style={styles.quitTitle}>Quit session?</p>
            <p style={styles.quitSub}>Your progress won't be saved.</p>
            <div style={styles.quitBtns}>
              <button style={styles.quitConfirmBtn} onClick={resetToSetup}>
                Quit
              </button>
              <button style={styles.quitCancelBtn} onClick={() => setShowQuitConfirm(false)}>
                Keep going
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(0.95); opacity: 0.3; }
          50% { transform: scale(1.05); opacity: 0.15; }
          100% { transform: scale(0.95); opacity: 0.3; }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────
const styles = {
  root: {
    fontFamily: "'DM Sans', sans-serif",
    background: "linear-gradient(170deg, #0a0e17 0%, #111827 40%, #0f172a 100%)",
    minHeight: "100vh",
    color: "#e2e8f0",
    position: "relative",
    overflow: "hidden",
  },
  noiseOverlay: {
    position: "fixed",
    inset: 0,
    opacity: 0.03,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
    pointerEvents: "none",
    zIndex: 0,
  },
  container: {
    position: "relative",
    zIndex: 1,
    maxWidth: 440,
    margin: "0 auto",
    padding: "48px 24px 40px",
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
  },
  activeContainer: {
    position: "relative",
    zIndex: 1,
    maxWidth: 440,
    margin: "0 auto",
    padding: "48px 24px 40px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
  },
  header: { textAlign: "center", marginBottom: 36 },
  title: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 52,
    fontWeight: 400,
    letterSpacing: "-0.02em",
    color: "#f1f5f9",
    lineHeight: 1,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "#64748b",
    fontWeight: 500,
  },
  statsBanner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    padding: "18px 20px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.06)",
    marginBottom: 32,
  },
  statItem: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 },
  statNumber: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 28,
    color: "#f1f5f9",
    lineHeight: 1.1,
  },
  statLabel: { fontSize: 11, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase" },
  statDivider: { width: 1, height: 32, background: "rgba(255,255,255,0.08)" },
  configSection: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 32,
  },
  configRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 18px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.06)",
  },
  configLabel: { fontSize: 15, color: "#cbd5e1", fontWeight: 500 },
  stepper: { display: "flex", alignItems: "center", gap: 14 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#e2e8f0",
    fontSize: 20,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    fontWeight: 300,
  },
  stepValue: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 22,
    color: "#f1f5f9",
    minWidth: 32,
    textAlign: "center",
  },
  startBtn: {
    width: "100%",
    padding: "16px 24px",
    fontSize: 16,
    fontWeight: 600,
    fontFamily: "'DM Sans', sans-serif",
    color: "#0a0e17",
    background: "linear-gradient(135deg, #78c8ff 0%, #60a5e8 100%)",
    border: "none",
    borderRadius: 14,
    cursor: "pointer",
    letterSpacing: "0.02em",
    boxShadow: "0 4px 24px rgba(120,200,255,0.2)",
  },
  todaySection: { marginTop: 32 },
  todayTitle: {
    fontSize: 13,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#64748b",
    fontWeight: 500,
    marginBottom: 12,
  },
  sessionCard: {
    padding: "14px 16px",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.05)",
    marginBottom: 8,
  },
  sessionCardRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sessionCardLabel: { fontSize: 14, color: "#94a3b8" },
  sessionCardTime: { fontSize: 14, color: "#78c8ff", fontWeight: 500 },
  retentionRow: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" },
  retentionPill: {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 20,
    background: "rgba(120,200,255,0.1)",
    color: "#78c8ff",
    fontWeight: 500,
  },
  retentionPillLight: {
    fontSize: 13,
    padding: "6px 14px",
    borderRadius: 20,
    background: "rgba(120,200,255,0.08)",
    color: "#93c5fd",
    fontWeight: 500,
  },
  roundIndicator: {
    fontSize: 13,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#64748b",
    position: "absolute",
    top: 48,
    fontWeight: 500,
  },
  orbContainer: {
    position: "relative",
    width: 260,
    height: 260,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
  },
  orbOuter: {
    position: "absolute",
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    background:
      "radial-gradient(circle, rgba(120,200,255,0.2) 0%, rgba(80,160,220,0.08) 50%, transparent 70%)",
    transition: "transform 1.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 1.5s ease",
  },
  orbInner: {
    position: "absolute",
    width: "65%",
    height: "65%",
    borderRadius: "50%",
    background:
      "radial-gradient(circle, rgba(120,200,255,0.5) 0%, rgba(80,160,220,0.2) 60%, transparent 80%)",
    transition: "transform 1.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 1.5s ease",
  },
  orbCenter: {
    position: "relative",
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  breathNum: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 48,
    color: "#f1f5f9",
    lineHeight: 1,
  },
  breathTotal: {
    fontSize: 16,
    color: "#64748b",
    marginTop: 2,
  },
  retentionTimer: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 52,
    color: "#fbbf6a",
    lineHeight: 1,
  },
  recoveryNum: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 56,
    color: "#78d6b5",
    lineHeight: 1,
  },
  phaseLabel: {
    fontSize: 22,
    fontWeight: 500,
    color: "#f1f5f9",
    textAlign: "center",
    marginBottom: 8,
  },
  phaseHint: {
    fontSize: 14,
    color: "#64748b",
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 1.5,
  },
  tapBtn: {
    marginTop: 24,
    padding: "14px 36px",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'DM Sans', sans-serif",
    color: "#fbbf6a",
    background: "rgba(251,191,106,0.1)",
    border: "1px solid rgba(251,191,106,0.25)",
    borderRadius: 50,
    cursor: "pointer",
    letterSpacing: "0.01em",
  },
  cancelBtn: {
    position: "fixed",
    top: 20,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(0,0,0,0.3)",
    color: "#64748b",
    fontSize: 16,
    cursor: "pointer",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  volumeDock: {
    position: "fixed",
    left: "50%",
    bottom: 14,
    transform: "translate(-50%, 22px)",
    zIndex: 12,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    opacity: 0.45,
    transition: "transform 360ms cubic-bezier(0.2, 1.2, 0.28, 1), opacity 200ms ease",
  },
  volumeDockOpen: {
    transform: "translate(-50%, 0)",
    opacity: 0.96,
  },
  volumeHandle: {
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(8,12,20,0.62)",
    borderRadius: 999,
    color: "#b7c2d8",
    height: 28,
    padding: "0 12px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    backdropFilter: "blur(8px)",
  },
  volumeHandleText: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  },
  volumeHandleValue: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 13,
    color: "#d5e4ff",
  },
  volumePanel: {
    marginTop: 8,
    width: 210,
    padding: "8px 14px 10px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(8,12,20,0.8)",
    backdropFilter: "blur(10px)",
    transform: "scale(0.94)",
    transformOrigin: "bottom center",
    transition: "transform 280ms cubic-bezier(0.2, 1.22, 0.38, 1)",
  },
  volumePanelOpen: {
    opacity: 1,
    transform: "scale(1)",
    pointerEvents: "auto",
  },
  volumePanelClosed: {
    opacity: 0,
    transform: "scale(0.88)",
    pointerEvents: "none",
  },
  volumeSlider: {
    width: "100%",
    accentColor: "#91c6ff",
    cursor: "pointer",
  },
  quitOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    backdropFilter: "blur(6px)",
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  quitCard: {
    background: "#161d2b",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 20,
    padding: "32px 28px",
    maxWidth: 320,
    width: "100%",
    textAlign: "center",
  },
  quitTitle: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 26,
    color: "#f1f5f9",
    marginBottom: 8,
  },
  quitSub: {
    fontSize: 14,
    color: "#64748b",
    marginBottom: 28,
  },
  quitBtns: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  quitConfirmBtn: {
    padding: "13px 0",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'DM Sans', sans-serif",
    color: "#f87171",
    background: "rgba(248,113,113,0.1)",
    border: "1px solid rgba(248,113,113,0.25)",
    borderRadius: 12,
    cursor: "pointer",
  },
  quitCancelBtn: {
    padding: "13px 0",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'DM Sans', sans-serif",
    color: "#f1f5f9",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    cursor: "pointer",
  },
  roundDoneStats: { textAlign: "center", marginBottom: 24, marginTop: 32 },
  rdStatBig: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  rdStatValue: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 64,
    color: "#78c8ff",
    lineHeight: 1,
  },
  rdStatLabel: {
    fontSize: 14,
    color: "#64748b",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginTop: 4,
  },
  allRetentions: {
    display: "flex",
    gap: 10,
    justifyContent: "center",
    flexWrap: "wrap",
    marginBottom: 32,
  },
  completeEmoji: {
    fontSize: 36,
    color: "#78c8ff",
    marginBottom: 8,
    display: "block",
  },
  completeTitle: {
    fontFamily: "'Instrument Serif', serif",
    fontSize: 36,
    fontWeight: 400,
    color: "#f1f5f9",
  },
  completeSummary: {
    padding: "20px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.06)",
  },
  csRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
  },
  csLabel: { fontSize: 14, color: "#94a3b8" },
  csValue: { fontSize: 16, color: "#f1f5f9", fontWeight: 600 },
  csDivider: {
    height: 1,
    background: "rgba(255,255,255,0.06)",
    margin: "4px 0",
  },
  csRetentions: {
    padding: "10px 0",
  },
};
