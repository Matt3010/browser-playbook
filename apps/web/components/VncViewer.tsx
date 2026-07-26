"use client";

import { useEffect, useRef, useState } from "react";

export type VncStatus = "connecting" | "connected" | "disconnected" | "error";

interface VncViewerProps {
  /** Authenticated path exposed by the API, including the temporary token. */
  path: string;
  onStatusChange?: (status: VncStatus) => void;
}

/**
 * Renders the remote browser through noVNC. The WebSocket goes to the API,
 * which validates the session token and proxies to the worker's websockify:
 * the VNC port itself is never reachable from the browser.
 */
export function VncViewer({ path, onStatusChange }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<VncStatus>("connecting");

  useEffect(() => {
    let disposed = false;
    let rfb: { disconnect: () => void } | null = null;

    const update = (next: VncStatus) => {
      if (disposed) return;
      setStatus(next);
      onStatusChange?.(next);
    };

    async function connect() {
      try {
        const module = await import("@novnc/novnc/lib/rfb.js");
        const RFB = (module as { default: unknown }).default as new (
          target: HTMLElement,
          url: string,
          options?: Record<string, unknown>
        ) => {
          disconnect: () => void;
          scaleViewport: boolean;
          resizeSession: boolean;
          viewOnly: boolean;
          addEventListener: (event: string, handler: (e: unknown) => void) => void;
        };

        if (disposed || !containerRef.current) return;

        const scheme = window.location.protocol === "https:" ? "wss" : "ws";
        const url = `${scheme}://${window.location.host}${path}`;

        const client = new RFB(containerRef.current, url, {
          wsProtocols: ["binary"]
        });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.viewOnly = false;
        client.addEventListener("connect", () => update("connected"));
        client.addEventListener("disconnect", () => update("disconnected"));
        client.addEventListener("securityfailure", () => update("error"));
        rfb = client;
      } catch {
        update("error");
      }
    }

    update("connecting");
    void connect();

    return () => {
      disposed = true;
      try {
        rfb?.disconnect();
      } catch {
        /* already gone */
      }
    };
  }, [path, onStatusChange]);

  return (
    <div className="relative h-full w-full bg-black" data-testid="vnc-viewer">
      <div ref={containerRef} className="h-full w-full" />
      {status !== "connected" ? (
        <p
          className="absolute inset-0 flex items-center justify-center text-sm text-slate-300"
          data-testid="vnc-status"
        >
          {status === "connecting"
            ? "Connessione al browser remoto..."
            : status === "disconnected"
              ? "Stream noVNC disconnesso"
              : "Errore di connessione noVNC"}
        </p>
      ) : (
        <span className="hidden" data-testid="vnc-connected" data-status="connected" />
      )}
    </div>
  );
}
