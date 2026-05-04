import { useEffect, useMemo, useRef, useState } from "react";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@app/components/v3";
import { TTerminalEvent } from "@app/hooks/api/pam";

import { parseRdpLogEntry, RdpEvent, RdpReplayPlayer } from "./rdpReplayPlayer";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const formatMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
};

type Props = {
  events: TTerminalEvent[];
};

export const RdpReplayView = ({ events }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<RdpReplayPlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const rdpEvents = useMemo<RdpEvent[]>(() => {
    const parsed: RdpEvent[] = [];
    for (const e of events) {
      const ev = parseRdpLogEntry(e);
      if (ev) parsed.push(ev);
    }
    parsed.sort((a, b) => a.elapsedMs - b.elapsedMs);
    return parsed;
  }, [events]);

  const totalMs = rdpEvents.length ? rdpEvents[rdpEvents.length - 1].elapsedMs : 0;

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas || rdpEvents.length === 0) return undefined;

    RdpReplayPlayer.create(rdpEvents, canvas, {
      onTick: (ms) => setCurrentMs(ms),
      onEnded: () => setIsPlaying(false)
    })
      .then((player) => {
        if (cancelled) {
          player.dispose();
          return;
        }
        playerRef.current = player;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to initialize RDP replay player");
      });

    return () => {
      cancelled = true;
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [rdpEvents]);

  const onPlayPause = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying) {
      p.pause();
      setIsPlaying(false);
    } else {
      p.play();
      setIsPlaying(true);
    }
  };

  const onRestart = () => {
    const p = playerRef.current;
    if (!p) return;
    p.restart();
    setIsPlaying(false);
    setCurrentMs(0);
  };

  if (error) {
    return (
      <div className="flex grow items-center justify-center text-sm text-danger">
        RDP replay failed to load: {error}
      </div>
    );
  }

  if (rdpEvents.length === 0) {
    return (
      <div className="flex grow items-center justify-center text-sm text-muted">
        No RDP events to replay yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="xs" onClick={onPlayPause}>
          {isPlaying ? (
            <PauseIcon className="mr-1.5 size-3.5" />
          ) : (
            <PlayIcon className="mr-1.5 size-3.5" />
          )}
          {isPlaying ? "Pause" : "Play"}
        </Button>
        <Button variant="outline" size="xs" onClick={onRestart}>
          <RotateCcwIcon className="mr-1.5 size-3.5" />
          Restart
        </Button>
        <span className="ml-2 font-mono text-xs text-muted">
          {formatMs(currentMs)} / {formatMs(totalMs)}
        </span>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-black">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="h-auto w-full"
          aria-label="RDP session replay"
        />
      </div>
    </div>
  );
};

// Default export for React.lazy convenience.
export default RdpReplayView;
