import { useCallback, useEffect, useRef, useState } from 'react';
import { isMoving } from '../../../../packages/game';
import { BALL_RADIUS, HEIGHT, WIDTH, type Round, type Vec } from '../../../../packages/game/types';

interface Props { round: Round; enabled: boolean; angle: number; power: number; setAngle: (value: number) => void; setPower: (value: number) => void; onShot: (impulse: Vec) => void; reducedMotion: boolean; highContrast: boolean; }
const palettes = {
  garden: { turf: '#21b263' },
  coast: { turf: '#20b56b' },
  night: { turf: '#20aa66' },
};
// This uniform camera inset shows the checkerboard outside the real collision
// boundary. Pointer coordinates use the exact inverse transform below.
const COURSE_SCALE = 0.84;
const COURSE_X = WIDTH * (1 - COURSE_SCALE) / 2;
const COURSE_Y = HEIGHT * (1 - COURSE_SCALE) / 2;

function drawCourse(canvas: HTMLCanvasElement, props: Props, dragging: boolean) {
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const { round, angle, power, enabled, highContrast } = props;
  const hole = round.holes[round.holeIndex];
  const colors = palettes[hole.theme];
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== WIDTH * ratio || canvas.height !== HEIGHT * ratio) { canvas.width = WIDTH * ratio; canvas.height = HEIGHT * ratio; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#43b6e7'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#4abbe9';
  for (let y = 0; y < HEIGHT; y += 16) for (let x = 0; x < WIDTH; x += 16) {
    if ((x / 16 + y / 16) % 2 === 0) ctx.fillRect(x, y, 16, 16);
  }
  ctx.save(); ctx.translate(COURSE_X, COURSE_Y); ctx.scale(COURSE_SCALE, COURSE_SCALE);
  ctx.fillStyle = 'rgba(22,100,119,.16)'; ctx.fillRect(0, 4, WIDTH, HEIGHT);
  ctx.fillStyle = colors.turf; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (const zone of hole.zones) {
    ctx.fillStyle = zone.kind === 'sand' ? '#efcf72' : '#32a9db';
    ctx.fillRect(zone.x, zone.y, zone.width, zone.height);
    if (zone.kind === 'water') {
      ctx.strokeStyle = 'rgba(255,255,255,.33)'; ctx.lineWidth = 2;
      for (let y = zone.y + 20; y < zone.y + zone.height - 10; y += 25) {
        ctx.beginPath(); ctx.moveTo(zone.x + 14, y); ctx.lineTo(zone.x + zone.width - 14, y); ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#d8b95e';
      for (let i = 0; i < 35; i++) ctx.fillRect(zone.x + 4 + (i * 31 % (zone.width - 8)), zone.y + 4 + (i * 23 % (zone.height - 8)), 2, 2);
    }
  }
  // The outer rectangle is the engine's actual world boundary, not scenery.
  ctx.lineJoin = 'miter'; ctx.lineWidth = highContrast ? 9 : 7;
  ctx.strokeStyle = highContrast ? '#ffffff' : '#d4dcdb'; ctx.strokeRect(0, 0, WIDTH, HEIGHT);
  ctx.lineCap = 'round';
  for (const wall of hole.walls) {
    ctx.beginPath(); ctx.moveTo(wall.a.x, wall.a.y + 3); ctx.lineTo(wall.b.x, wall.b.y + 3); ctx.strokeStyle = 'rgba(0,85,56,.2)'; ctx.lineWidth = 8; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wall.a.x, wall.a.y); ctx.lineTo(wall.b.x, wall.b.y); ctx.strokeStyle = highContrast ? '#ffffff' : '#d4dcdb'; ctx.lineWidth = 8; ctx.stroke();
  }
  ctx.fillStyle = '#09251d'; ctx.beginPath(); ctx.arc(hole.cup.x, hole.cup.y, 11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#e0e8e4'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(hole.cup.x, hole.cup.y - 2); ctx.lineTo(hole.cup.x, hole.cup.y - 52); ctx.stroke();
  ctx.fillStyle = '#ff8878'; ctx.beginPath(); ctx.moveTo(hole.cup.x + 1.25, hole.cup.y - 52); ctx.lineTo(hole.cup.x + 29, hole.cup.y - 40); ctx.lineTo(hole.cup.x + 1.25, hole.cup.y - 27); ctx.fill();
  if (round.status === 'playing') {
    if (enabled && !isMoving(round)) {
      const radians = angle * Math.PI / 180; const length = 30 + power * 1.2;
      ctx.save(); ctx.translate(round.ball.x, round.ball.y); ctx.rotate(radians);
      ctx.lineWidth = dragging ? 3 : 2; ctx.strokeStyle = dragging ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.48)'; ctx.setLineDash(dragging ? [] : [3, 7]); ctx.beginPath(); ctx.moveTo(17, 0); ctx.lineTo(length, 0); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(length - 6, -5); ctx.lineTo(length, 0); ctx.lineTo(length - 6, 5); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(0,90,50,.15)'; ctx.beginPath(); ctx.arc(round.ball.x, round.ball.y + 2, BALL_RADIUS, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(round.ball.x, round.ball.y, BALL_RADIUS, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export function CourseCanvas(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef(false);
  const activePointer = useRef<number | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const aim = useRef({ angle: props.angle, power: props.power });
  const initialAim = useRef({ angle: props.angle, power: props.power });
  const [dragging, setDragging] = useState(false);
  const hole = props.round.holes[props.round.holeIndex];
  const available = props.enabled && props.round.status === 'playing' && !isMoving(props.round);
  aim.current = { angle: props.angle, power: props.power };
  useEffect(() => { if (canvas.current) drawCourse(canvas.current, props, dragging); }, [props, dragging]);
  const cancelDrag = useCallback(() => {
    if (!drag.current) return;
    const pointerId = activePointer.current;
    drag.current = false; activePointer.current = null; setDragging(false);
    aim.current = { ...initialAim.current };
    props.setAngle(initialAim.current.angle); props.setPower(initialAim.current.power);
    if (pointerId !== null && canvas.current?.hasPointerCapture(pointerId)) canvas.current.releasePointerCapture(pointerId);
  }, [props.setAngle, props.setPower]);
  useEffect(() => { if (!available) cancelDrag(); }, [available, cancelDrag]);
  useEffect(() => {
    const cancelHiddenDrag = () => { if (document.hidden) cancelDrag(); };
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('visibilitychange', cancelHiddenDrag);
    return () => {
      window.removeEventListener('blur', cancelDrag);
      document.removeEventListener('visibilitychange', cancelHiddenDrag);
    };
  }, [cancelDrag]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - bounds.left) * WIDTH / bounds.width - COURSE_X) / COURSE_SCALE, y: ((event.clientY - bounds.top) * HEIGHT / bounds.height - COURSE_Y) / COURSE_SCALE };
  };
  const shootAim = () => { const radians = aim.current.angle * Math.PI / 180; const speed = 80 + aim.current.power / 100 * 640; props.onShot({ x: Math.cos(radians) * speed, y: Math.sin(radians) * speed }); };
  const updateDragAim = (p: { x: number; y: number }) => {
    const dx = props.round.ball.x - p.x; const dy = props.round.ball.y - p.y;
    const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const power = Math.max(5, Math.min(100, Math.hypot(dx, dy) / 1.8));
    aim.current = { angle, power }; props.setAngle(angle); props.setPower(power);
  };
  return <canvas ref={canvas} className={`course-canvas ${available ? 'aimable' : ''}`} width={WIDTH} height={HEIGHT} tabIndex={0}
    role="application" aria-label={`Mini golf course, hole ${props.round.holeIndex + 1}: ${hole.name}`} aria-describedby="aim-instructions aim-state"
    aria-disabled={!available} aria-description={`Aim ${Math.round(props.angle) % 360} degrees, power ${Math.round(props.power)} percent. Focus the course; left and right arrows aim, up and down arrows change power, Space putts. Escape cancels a drag, or saves and hides when no drag is active.`}
    onBlur={cancelDrag}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault(); event.stopPropagation(); cancelDrag(); return;
      }
      // The pointer owns aim and release until its gesture ends or is canceled.
      if (drag.current && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (!available) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(event.key)) event.preventDefault();
      if (event.key === 'ArrowLeft') props.setAngle((props.angle + 355) % 360);
      if (event.key === 'ArrowRight') props.setAngle((props.angle + 5) % 360);
      if (event.key === 'ArrowUp') props.setPower(Math.min(100, props.power + 5));
      if (event.key === 'ArrowDown') props.setPower(Math.max(5, props.power - 5));
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) shootAim();
    }}
    onPointerDown={event => {
      if (!available || drag.current || event.button !== 0) return; const p = point(event);
      if (Math.hypot(p.x - props.round.ball.x, p.y - props.round.ball.y) > 80) return;
      initialAim.current = { ...aim.current };
      dragStart.current = p; activePointer.current = event.pointerId;
      event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = true; setDragging(true);
    }}
    onPointerMove={event => {
      if (!drag.current || !available || event.pointerId !== activePointer.current) return;
      updateDragAim(point(event));
    }}
    onPointerUp={event => {
      if (!drag.current || event.pointerId !== activePointer.current) return;
      const p = point(event);
      const pull = Math.hypot(p.x - dragStart.current.x, p.y - dragStart.current.y);
      const distance = Math.hypot(p.x - props.round.ball.x, p.y - props.round.ball.y);
      if (available && pull >= 6 && distance >= 6) {
        updateDragAim(p); drag.current = false; activePointer.current = null; setDragging(false); shootAim();
      } else cancelDrag();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={event => { if (event.pointerId === activePointer.current) cancelDrag(); }}
    onLostPointerCapture={event => { if (event.pointerId === activePointer.current) cancelDrag(); }}
  >Drag back from the ball, then release to putt. Pull farther for more speed. Keyboard: focus the course, use left and right arrows to aim, up and down arrows for power, and Space to putt.</canvas>;
}
