import { useState, useEffect, useRef, useCallback } from "react";

interface LatencyResult {
  latencyMs: number | null;
  status: "measuring" | "good" | "warning" | "error";
  error: string | null;
}

export function useConnectionLatency(url: string | null, intervalMs = 5000): LatencyResult {
  const [result, setResult] = useState<LatencyResult>({
    latencyMs: null,
    status: "measuring",
    error: null,
  });
  const lastPingRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const measureLatency = useCallback(async () => {
    if (!url) {
      setResult({ latencyMs: null, status: "error", error: "No URL provided" });
      return;
    }

    const start = performance.now();
    lastPingRef.current = start;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    timeoutRef.current = timeoutId;

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });

      if (lastPingRef.current !== start) return;

      if (response.ok || response.status === 204) {
        const end = performance.now();
        const latency = Math.round(end - start);
        setResult({
          latencyMs: latency,
          status: latency < 100 ? "good" : latency < 300 ? "warning" : "error",
          error: null,
        });
      } else {
        setResult((prev) => ({
          ...prev,
          status: "error",
          error: `HTTP ${response.status}`,
        }));
      }
    } catch (err) {
      if (lastPingRef.current !== start) return;
      const end = performance.now();
      const latency = Math.round(end - start);

      if (err instanceof Error && err.name === "AbortError") {
        setResult({ latencyMs: null, status: "error", error: "Timeout" });
      } else {
        setResult({
          latencyMs: latency > 5000 ? null : latency,
          status: "error",
          error: err instanceof Error ? err.message : "Connection failed",
        });
      }
    } finally {
      if (timeoutRef.current === timeoutId) {
        clearTimeout(timeoutId);
        timeoutRef.current = null;
      }
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;

    measureLatency();

    const intervalId = setInterval(measureLatency, intervalMs);

    return () => {
      clearInterval(intervalId);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      abortRef.current?.abort();
    };
  }, [url, intervalMs, measureLatency]);

  return result;
}
