import React from 'react';
import { useEffect, useRef, useState, useCallback } from 'react'

const WORLD_SIZE = 2000
const MAX_SCALE = 5
const PAN_THRESHOLD = 5
const COOLDOWN_MS = 1000


const PALETTE = [
  // Row 1: Classic
  '#FFFFFF', '#000000',  '#FF3B30', '#FF9500',
  // Row 2: Warm
  '#FFCC00', '#FF6B6B', '#FF8E53', '#FFB347',
  // Row 3: Pastel 🎨
  '#FFB3BA', '#FFDFBA', '#FFFFBA', '#BAFFC9',
  '#BAE1FF', '#E8BAFF', '#FFB3F0', '#C9FFE5',
  // Row 4: Cool
  '#4CD964', '#5AC8FA', '#007AFF', '#5856D6',
  '#FF2D55', '#8E8E93', '#8B572A', '#34C759',
]
const HEX_TO_RGBA = PALETTE.map(hex => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, 255]; 
});

const getOrCreateUserID = () => {
  let id = localStorage.getItem('pixel_user_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    localStorage.setItem('pixel_user_id', id);
  }
  return id;
};

const getOrCreateName = () => {
  let name = localStorage.getItem('pixel_name');
  if (!name) {
    name = 'Player_' + Math.floor(Math.random() * 1000);
    localStorage.setItem('pixel_name', name);
  }
  return name;
};

const getOrCreateColor = () => {
  let color = localStorage.getItem('pixel_color');
  if (!color) {
    color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    localStorage.setItem('pixel_color', color);
  }
  return color;
};

export default function App() {
  const canvasRef = useRef(null)
  const wrapperRef = useRef(null)
  const wsRef = useRef(null)
  const audioCtxRef = useRef(null) 
  const userId = useRef(getOrCreateUserID());
  const tabId = useRef(Math.random().toString(36).substr(2, 9));

  const [activeColor, setActiveColorState] = useState(getOrCreateColor)
  const [myName, setMyNameState] = useState(getOrCreateName)
  const activeColorRef = useRef(activeColor)
  const myNameRef = useRef(myName)

  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [showLeaderboard, setShowLeaderboard] = useState(true)
  const [leaderboard, setLeaderboard] = useState([])
  const lbUpdateQueue = useRef([]);

  const [scale, setScaleState] = useState(1)
  const scaleRef = useRef(1)
  const [offset, setOffsetState] = useState({ x: 0, y: 0 })
  const offsetRef = useRef({ x: 0, y: 0 })

  const [isCoolingDown, setIsCoolingDown] = useState(false)
  const lastDrawTimeRef = useRef(0)
  const [popPixels, setPopPixels] = useState([])

  const touchStart = useRef(null)
  const touchDidPan = useRef(false)
  const mouseDown = useRef(null) 
  const didPan = useRef(false)

  const [paletteOffset, setPaletteOffset] = useState(0)
  const VISIBLE = 8

  const [slideDir, setSlideDir] = useState(null)

  const setActiveColor = useCallback((color) => {
    setActiveColorState(color);
    localStorage.setItem('pixel_color', color);
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ 
        type: 'profile', 
        userId: userId.current, 
        name: myNameRef.current, 
        color: color 
      }));
    }
  }, []);

  const setMyName = useCallback((name) => {
    const sanitized = name.replace(/[<>]/g, '').trim().slice(0, 24);
    if (!sanitized) return;
    setMyNameState(sanitized);
    localStorage.setItem('pixel_name', sanitized);
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ 
        type: 'profile', 
        userId: userId.current, 
        name: sanitized, 
        color: activeColorRef.current 
      }));
    }
  }, []);

  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'pixel_name' && e.newValue) setMyNameState(e.newValue);
      if (e.key === 'pixel_color' && e.newValue) setActiveColorState(e.newValue);
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  useEffect(() => { activeColorRef.current = activeColor }, [activeColor])
  useEffect(() => { myNameRef.current = myName }, [myName])

  const playPopSound = useCallback(() => {
  try {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = audioCtxRef.current
    if (ctx.state === 'suspended') ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(600, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.05)
    gain.gain.setValueAtTime(0.4, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05)
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.05)
  } catch(e) {}
}, [])

  const playScrollSound = useCallback(() => {
  try {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = audioCtxRef.current
    if (ctx.state === 'suspended') ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(800, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08)
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.08)
  } catch(e) {}

  }, [])

  const setScale = useCallback((val) => {
    const v = typeof val === 'function' ? val(scaleRef.current) : val
    scaleRef.current = v; setScaleState(v)
  }, [])

  const setOffset = useCallback((val) => {
    const v = typeof val === 'function' ? val(offsetRef.current) : val
    offsetRef.current = v; setOffsetState(v)
  }, [])

  const clampOffset = useCallback((ox, oy, s) => {
    const vw = window.innerWidth, vh = window.innerHeight
    const cw = WORLD_SIZE * s, ch = WORLD_SIZE * s
    const nx = cw <= vw ? (vw - cw) / 2 : Math.max(vw - cw, Math.min(0, ox))
    const ny = ch <= vh ? (vh - ch) / 2 : Math.max(vh - ch, Math.min(0, oy))
    return { x: nx, y: ny }
  }, [])

  const zoomAt = useCallback((newScale, pivotX, pivotY) => {
    const fit = window.innerWidth / WORLD_SIZE
    const clamped = Math.max(fit, Math.min(MAX_SCALE, newScale))
    const ratio = clamped / scaleRef.current
    const { x: ox, y: oy } = offsetRef.current
    const { x, y } = clampOffset(pivotX - ratio * (pivotX - ox), pivotY - ratio * (pivotY - oy), clamped)
    setScale(clamped); setOffset({ x, y })
  }, [clampOffset, setScale, setOffset])

  const drawPixel = useCallback((x, y, color) => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = color; ctx.fillRect(x, y, 10, 10);
  }, []);

  // Leaderboard update interval
  useEffect(() => {
    const timer = setInterval(() => {
      if (lbUpdateQueue.current.length === 0) return;
      setLeaderboard(prev => {
        let next = [...prev];
        lbUpdateQueue.current.forEach(msg => {
          const idx = next.findIndex(p => p.userId === msg.userId);
          if (idx > -1) next[idx] = { ...next[idx], score: next[idx].score + 1, name: msg.name, color: msg.color };
          else next.push({ userId: msg.userId, name: msg.name, score: 1, color: msg.color });
        });
        lbUpdateQueue.current = [];
        return next.sort((a, b) => b.score - a.score).slice(0, 100);
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Center on mount
  useEffect(() => {
    const startScale = 1;
    const centerX = (window.innerWidth - WORLD_SIZE * startScale) / 2;
    const centerY = (window.innerHeight - WORLD_SIZE * startScale) / 2;
    setScale(startScale);
    setOffset({ x: centerX, y: centerY });
  }, [setScale, setOffset]);

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE)
      ctx.fillStyle = 'rgba(0,0,0,0.06)'
      for (let i = 0; i <= WORLD_SIZE; i += 10) { ctx.fillRect(i, 0, 1, WORLD_SIZE); ctx.fillRect(0, i, WORLD_SIZE, 1) }
    }
    let ws, isUnmounted = false;
    const connectWS = () => {
      if (isUnmounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      ws = new WebSocket(`${protocol}//${host}/ws`); wsRef.current = ws
      ws.binaryType = 'arraybuffer'; // Crucial for binary protocol

      ws.onopen = () => {
        // Send initial profile to server
        ws.send(JSON.stringify({
          type: 'profile',
          userId: userId.current,
          name: myNameRef.current,
          color: activeColorRef.current
        }));
      };

      ws.onmessage = async (event) => {
        let buffer = event.data;
        if (buffer instanceof Blob) buffer = await buffer.arrayBuffer();

        if (buffer instanceof ArrayBuffer) {
          const view = new Uint8Array(buffer);
          if (view.length === 0) return;

          const type = view[0];

          if (type === 0) {
            console.log(`📦 [INIT] โหลดกระดาน Binary 4MB เรนเดอร์ด้วย ImageData`);
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            
            // สร้างกระดานภาพจำลองในแรม
            const imgData = ctx.createImageData(WORLD_SIZE, WORLD_SIZE);
            const data = imgData.data;

            // วนลูปอ่านข้อมูล Binary แล้ววาดพิกเซล 10x10 ลงใน imgData
            for (let y = 0; y < WORLD_SIZE; y += 10) {
              for (let x = 0; x < WORLD_SIZE; x += 10) {
                const offset = (y * WORLD_SIZE) + x;
                if (offset + 1 >= view.length) continue;
                
                const colorIdx = view[offset + 1];
                if (colorIdx === 255 || colorIdx >= PALETTE.length) continue; // ข้ามช่องว่าง

                const rgba = HEX_TO_RGBA[colorIdx];
                
                // ขยายสเกล 1 จุดให้กลายเป็น 10x10 พิกเซล
                for (let dy = 0; dy < 10; dy++) {
                  for (let dx = 0; dx < 10; dx++) {
                    const px = x + dx;
                    const py = y + dy;
                    const p = (py * WORLD_SIZE + px) * 4;
                    data[p] = rgba[0];     // R
                    data[p+1] = rgba[1];   // G
                    data[p+2] = rgba[2];   // B
                    data[p+3] = rgba[3];   // A
                  }
                }
              }
            }
            // สาดรูปลงกระดานรวดเดียวจบ! (O(1) Rendering)
            ctx.putImageData(imgData, 0, 0);
            
            // วาดเส้นตารางทับลงไปอีกรอบให้สวยงาม
            ctx.fillStyle = 'rgba(0,0,0,0.06)';
            for (let i = 0; i <= WORLD_SIZE; i += 10) {
              ctx.fillRect(i, 0, 1, WORLD_SIZE);
              ctx.fillRect(0, i, WORLD_SIZE, 1);
            }

          } else if (type === 1) {
            // 🚀 Draw Pixel (6 bytes)
            if (view.length >= 6) {
              const dataView = new DataView(buffer);
              const x = dataView.getUint16(1, false);
              const y = dataView.getUint16(3, false);
              const colorIdx = view[5];
              if (colorIdx < PALETTE.length) drawPixel(x, y, PALETTE[colorIdx]);
            }
          }
        } else {
          // โค้ดรับ JSON แบบเดิมสำหรับ Leaderboard
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'leaderboard') setLeaderboard(msg.leaderboard || []);
          } catch (e) {}
        }
      };
      ws.onclose = () => { if (!isUnmounted) setTimeout(connectWS, 2000) }
    }
    connectWS();
    const onResize = () => setOffset(prev => clampOffset(prev.x, prev.y, scaleRef.current))
    window.addEventListener('resize', onResize)
    return () => { isUnmounted = true; if (ws) ws.close(); window.removeEventListener('resize', onResize) }
  }, [clampOffset, drawPixel, setOffset])

  const handleDraw = useCallback((clientX, clientY) => {
  const now = Date.now()
  if (now - lastDrawTimeRef.current < COOLDOWN_MS) return
  const canvas = canvasRef.current; if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = Math.floor((clientX - rect.left) / scaleRef.current / 10) * 10
  const y = Math.floor((clientY - rect.top) / scaleRef.current / 10) * 10
  if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE) return
  
  lastDrawTimeRef.current = now
  setIsCoolingDown(true)
  setTimeout(() => setIsCoolingDown(false), COOLDOWN_MS)
  playPopSound()

  // ✅ drawPixel ทันทีเลย ไม่ต้องรอ animation
  drawPixel(x, y, activeColorRef.current)

  if (wsRef.current?.readyState === WebSocket.OPEN) {
    const colorIdx = PALETTE.indexOf(activeColorRef.current)
    if (colorIdx !== -1) {
      const buffer = new ArrayBuffer(6)
      const view = new DataView(buffer)
      view.setUint8(0, 1)
      view.setUint16(1, x, false)
      view.setUint16(3, y, false)
      view.setUint8(5, colorIdx)
      wsRef.current.send(buffer)
    }
  }

  // Animation แค่ overlay ไม่ affect canvas จริง
  const popId = Date.now() + Math.random()
  setPopPixels(prev => [...prev, { id: popId, x, y, color: activeColorRef.current }])
  setTimeout(() => setPopPixels(prev => prev.filter(p => p.id !== popId)), 500)
}, [drawPixel, playPopSound])

  useEffect(() => {
  const el = wrapperRef.current; if (!el) return
  const onWheel = (e) => {
    e.preventDefault()
    if (e.ctrlKey) {
      // Pinch touchpad หรือ Ctrl+scroll = zoom
      zoomAt(
        scaleRef.current * (1 - e.deltaY * 0.01),
        e.clientX,
        e.clientY
      )
    } else {
      // Scroll ปกติ = pan
      setOffset(prev => clampOffset(
        prev.x - e.deltaX,
        prev.y - e.deltaY,
        scaleRef.current
      ))
    }
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => el.removeEventListener('wheel', onWheel)
}, [zoomAt, clampOffset, setOffset])

  useEffect(() => {
    const el = wrapperRef.current; if (!el) return
    const onDown = (e) => { if (e.button !== 0) return; mouseDown.current = { x: e.clientX, y: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y }; didPan.current = false }
    const onMove = (e) => {
      if (!mouseDown.current) return
      const dx = e.clientX - mouseDown.current.x, dy = e.clientY - mouseDown.current.y
      if (!didPan.current && Math.hypot(dx, dy) < PAN_THRESHOLD) return
      didPan.current = true; el.classList.add('is-grabbing')
      setOffset(clampOffset(mouseDown.current.ox + dx, mouseDown.current.oy + dy, scaleRef.current))
    }
    const onUp = (e) => { if (!mouseDown.current) return; el.classList.remove('is-grabbing'); if (!didPan.current) handleDraw(e.clientX, e.clientY); mouseDown.current = null }
    el.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { el.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [clampOffset, setOffset, handleDraw])

  

  return (
    <>
      <style>{`
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; overflow: hidden; background: #1a1a2e; font-family: 'DM Mono', monospace; }

  .world-wrapper {
    position: fixed; inset: 0; overflow: hidden;
    touch-action: none; user-select: none;
    background: 
      radial-gradient(ellipse at 20% 50%, rgba(120,80,255,0.08) 0%, transparent 60%),
      radial-gradient(ellipse at 80% 20%, rgba(255,100,100,0.06) 0%, transparent 50%),
      #1a1a2e;
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z' fill='%23FFF' stroke='%23000' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") 3 3, default;
  }
  .world-wrapper.on-cooldown { cursor: not-allowed; }
  .world-wrapper.is-grabbing { cursor: grabbing !important; }

  .canvas-transform {
    position: absolute; top: 0; left: 0;
    transform-origin: 0 0; will-change: transform;
    image-rendering: pixelated;        /* ✅ เพิ่มตรงนี้ */
    image-rendering: crisp-edges; 
    /* pixel art border feel */
    filter: drop-shadow(0 0 40px rgba(0,0,0,0.8));
  }

  /* 🎯 Animation เด้งดึ๋งใหม่ */
  .pixel-spring {
    position: absolute; width: 10px; height: 10px;
    pointer-events: none; z-index: 10;
    animation: bouncePop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.8) forwards;
    border-radius: 2px;
  }
  @keyframes bouncePop {
    0%   { transform: scale(0) rotate(-15deg); opacity: 1; }
    40%  { transform: scale(1.6) rotate(5deg); opacity: 1; }
    65%  { transform: scale(0.85) rotate(-2deg); opacity: 1; }
    80%  { transform: scale(1.1) rotate(1deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 0; }
  }

  /* ripple effect */
  .pixel-ripple {
    position: absolute; width: 10px; height: 10px;
    pointer-events: none; z-index: 9; border-radius: 2px;
    animation: rippleOut 0.5s ease-out forwards;
    border: 2px solid currentColor;
  }
  @keyframes rippleOut {
    0%   { transform: scale(1); opacity: 0.8; }
    100% { transform: scale(3.5); opacity: 0; }
  }

  .hud { position: fixed; inset: 0; pointer-events: none; z-index: 30; }

  .my-info {
    position: absolute; top: 14px; left: 14px; pointer-events: all;
    display: flex; align-items: center; gap: 8px;
    background: rgba(10,10,20,0.85); backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 8px 14px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
  }
  .color-dot {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.4); flex-shrink: 0;
    box-shadow: 0 0 8px currentColor;
  }
  .name-display {
    color: rgba(255,255,255,0.85); font-size: 12px; letter-spacing: 0.04em;
    cursor: pointer; white-space: nowrap; transition: color 0.15s;
  }
  .name-display:hover { color: #fff; }
  .name-input {
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.2);
    border-radius: 6px; color: #fff; font-family: inherit; font-size: 12px;
    padding: 3px 8px; outline: none; width: 120px;
  }
  .name-ok {
    height: 24px; padding: 0 9px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.09);
    color: rgba(255,255,255,0.75); cursor: pointer; font-family: inherit; font-size: 11px;
  }

  .lb-toggle {
    position: absolute; top: 14px; right: 14px; pointer-events: all;
    height: 36px; padding: 0 16px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(10,10,20,0.85); backdrop-filter: blur(20px);
    color: rgba(255,255,255,0.8); font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
    transition: all 0.2s;
  }
  .lb-toggle:hover { background: rgba(30,30,50,0.95); color: #fff; }

  .lb-panel {
    position: absolute; top: 60px; right: 14px; width: 240px; pointer-events: all;
    background: rgba(10,10,20,0.92); backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6); transition: opacity 0.22s, transform 0.22s;
  }
  .lb-panel.hidden { opacity: 0; transform: translateY(-8px) scale(0.97); pointer-events: none; }
  .lb-header { padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .lb-title { color: rgba(255,255,255,0.5); font-size: 10px; letter-spacing: 0.2em; font-weight: 600; margin: 0; text-transform: uppercase; }
  .lb-list { list-style: none; padding: 6px 0; margin: 0; max-height: 300px; overflow-y: auto; }
  .lb-row { display: flex; align-items: center; padding: 7px 14px; gap: 10px; transition: background 0.15s; }
  .lb-row:hover { background: rgba(255,255,255,0.03); }
  .lb-rank-badge {
    width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.05); border-radius: 4px;
    font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.4);
  }
  .lb-rank-badge.top { color: #FFD700; background: rgba(255,215,0,0.1); }
  .lb-player-color { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .lb-name { color: rgba(255,255,255,0.85); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb-score { color: #fff; font-size: 11px; background: rgba(255,255,255,0.08); padding: 2px 7px; border-radius: 10px; font-weight: 600; }

  /* 🎨 Palette แบบ grid */
  .palette-panel {
  position: absolute; bottom: 70px; left: 50%; transform: translateX(-50%);
  pointer-events: all; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  background: rgba(10,10,20,0.9); backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 20px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  overflow: visible;
  padding: 12px 14px;
}

.palette-track {
  display: flex; gap: 6px;
  overflow: visible;
}

@keyframes slideLeft {
  0%   { transform: translateX(20px); opacity: 0.3; }
  100% { transform: translateX(0);    opacity: 1; }
}
@keyframes slideRight {
  0%   { transform: translateX(-20px); opacity: 0.3; }
  100% { transform: translateX(0);     opacity: 1; }
}

.palette-track.slide-left  { animation: slideLeft  0.25s cubic-bezier(0.175, 0.885, 0.32, 1.4); }
.palette-track.slide-right { animation: slideRight 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.4); }

.palette-arrow {
  width: 28px; height: 28px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.07);
  color: #fff; font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, transform 0.15s;
  line-height: 1;
}
.palette-arrow:hover:not(:disabled) { 
  background: rgba(255,255,255,0.18); 
  transform: scale(1.1); 
}
.palette-arrow:disabled { 
  opacity: 0.25; cursor: not-allowed; 
}

  .color-swatch {
  width: 36px; height: 36px;
  border-radius: 10px; cursor: pointer;
  border: none;
  position: relative;
  transition: transform 0.15s cubic-bezier(0.175, 0.885, 0.32, 1.8);

  /* 3D Candy Effect */
  box-shadow:
    inset 0 3px 0 rgba(255,255,255,0.45),   /* highlight บน */
    inset 0 -3px 0 rgba(0,0,0,0.25),         /* shadow ล่าง */
    inset 3px 0 0 rgba(255,255,255,0.1),      /* highlight ซ้าย */
    inset -3px 0 0 rgba(0,0,0,0.1),           /* shadow ขวา */
    0 4px 0 rgba(0,0,0,0.3),                  /* drop shadow */
    0 6px 12px rgba(0,0,0,0.3);               /* ambient shadow */

  /* filter เพิ่มความอิ่มสี */
  filter: saturate(1.1);
}

.color-swatch::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 9px;
  background: linear-gradient(
    160deg,
    rgba(255,255,255,0.35) 0%,
    rgba(255,255,255,0.0) 50%
  );
  pointer-events: none;
}

.color-swatch:hover {
  transform: translateY(-3px) scale(1.08);
  box-shadow:
    inset 0 3px 0 rgba(255,255,255,0.45),
    inset 0 -3px 0 rgba(0,0,0,0.25),
    0 7px 0 rgba(0,0,0,0.3),
    0 10px 16px rgba(0,0,0,0.35);
}

.color-swatch:active {
  transform: translateY(2px) scale(0.97);
  box-shadow:
    inset 0 3px 0 rgba(255,255,255,0.45),
    inset 0 -1px 0 rgba(0,0,0,0.25),
    0 2px 0 rgba(0,0,0,0.3),
    0 3px 6px rgba(0,0,0,0.25);
}

.color-swatch.active {
  transform: translateY(1px) scale(1.05);
  box-shadow:
    inset 0 3px 0 rgba(255,255,255,0.45),
    inset 0 -2px 0 rgba(0,0,0,0.25),
    0 3px 0 rgba(0,0,0,0.3),
    0 0 0 2.5px #fff,
    0 0 16px rgba(255,255,255,0.3),
    0 5px 12px rgba(0,0,0,0.3);
}
  .color-swatch:hover { transform: scale(1.2) translateY(-2px); border-color: rgba(255,255,255,0.4); }
  .color-swatch.active {
    transform: scale(1.3) translateY(-3px);
    border-color: #fff;
    box-shadow: 0 0 12px rgba(255,255,255,0.4), inset 0 1px 0 rgba(255,255,255,0.4), 0 4px 12px rgba(0,0,0,0.4);
  }

  .zoom-panel {
    position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
    pointer-events: all; display: flex; align-items: center; gap: 6px;
    background: rgba(10,10,20,0.85); backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 40px;
    padding: 6px 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  .zoom-btn {
    width: 26px; height: 26px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06);
    color: #fff; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, transform 0.15s;
  }
  .zoom-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.1); }
  .zoom-btn:active { transform: scale(0.92); }

  /* Cooldown bar */
  .cooldown-bar {
    position: absolute; bottom: 0; left: 0; height: 2px;
    background: linear-gradient(90deg, #007AFF, #5856D6);
    transition: width 0.05s linear;
    border-radius: 0 2px 2px 0;
  }
  canvas {
  image-rendering: pixelated;
  image-rendering: -moz-crisp-edges;
  image-rendering: crisp-edges;
}
`}</style>

      <div ref={wrapperRef} className={`world-wrapper ${isCoolingDown ? 'on-cooldown' : ''}`}>
        <div className="canvas-transform" style={{ transform: `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px) scale(${scale})` }}>
          <canvas ref={canvasRef} width={WORLD_SIZE} height={WORLD_SIZE} style={{ display: 'block', imageRendering: 'pixelated' }} />
          {popPixels.map(p => (
  <React.Fragment key={p.id}>
    <div className="pixel-spring" style={{ left: p.x, top: p.y, backgroundColor: p.color }} />
    <div className="pixel-ripple" style={{ left: p.x, top: p.y, color: p.color }} />
  </React.Fragment>
))}
        </div>
      </div>

      <div className="hud">
        <div className="my-info">
          <div className="color-dot" style={{ backgroundColor: activeColor }} />
          {editingName ? (
            <>
              <input autoFocus className="name-input" value={draftName} onChange={e => setDraftName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { setMyName(draftName); setEditingName(false) } }} onBlur={() => setTimeout(() => setEditingName(false), 150)} />
              <button className="name-ok" onClick={() => { setMyName(draftName); setEditingName(false) }}>OK</button>
            </>
          ) : (
            <span className="name-display" onClick={() => { setDraftName(myName); setEditingName(true) }}>{myName} ✎</span>
          )}
        </div>

        <button className="lb-toggle" onClick={() => setShowLeaderboard(!showLeaderboard)}>SCORE</button>
        <div className={`lb-panel${showLeaderboard ? '' : ' hidden'}`}>
          <div className="lb-header"><p className="lb-title">Leaderboard</p></div>
          <ul className="lb-list">
            {leaderboard.map((player, i) => (
              <li key={i} className="lb-row">
                <div className={`lb-rank-badge ${i < 3 ? 'top' : ''}`}>{i + 1}</div>
                <div className="lb-player-color" style={{ backgroundColor: player.color }} />
                <span className="lb-name">{player.name}</span>
                <span className="lb-score">{player.score}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="palette-panel">
  <button 
  className="palette-arrow" 
  onClick={() => {
    setPaletteOffset(o => Math.max(0, o - 1))
    setSlideDir('right')
    playScrollSound()
    setTimeout(() => setSlideDir(null), 250)
  }}
  disabled={paletteOffset === 0}
>‹</button>

<div className={`palette-track ${slideDir ? 'slide-' + slideDir : ''}`}>
    {PALETTE.slice(paletteOffset, paletteOffset + VISIBLE).map(c => (
      <div 
        key={c} 
        className={`color-swatch ${activeColor === c ? 'active' : ''}`} 
        style={{ backgroundColor: c }} 
        onClick={() => setActiveColor(c)} 
      />
    ))}
  </div>

  <button 
  className="palette-arrow" 
  onClick={() => {
    setPaletteOffset(o => Math.min(PALETTE.length - VISIBLE, o + 1))
    setSlideDir('left')
    playScrollSound()
    setTimeout(() => setSlideDir(null), 250)
  }}
  disabled={paletteOffset >= PALETTE.length - VISIBLE}
>›</button>
</div>

        <div className="zoom-panel">
          <button className="zoom-btn" onClick={() => zoomAt(scaleRef.current / 1.3, window.innerWidth / 2, window.innerHeight / 2)}>−</button>
          <span style={{ color: '#fff', fontSize: '11px', minWidth: '38px', textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
          <button className="zoom-btn" onClick={() => zoomAt(scaleRef.current * 1.3, window.innerWidth / 2, window.innerHeight / 2)}>+</button>
        </div>
      </div>
    </>
  )
}