/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import type { Tick } from '@/types/market.types';

export interface LiveTick {
  bid: number;
  ask: number;
  last: number;
}

interface MarketSocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  lastTickTime: number | null;
  ticks: ReadonlyMap<string, LiveTick>;
  subscribe: (accountId: string, symbol: string) => void;
  unsubscribe: (accountId: string, symbol: string) => void;
}

const MarketSocketContext = createContext<MarketSocketContextValue>({
  socket: null,
  isConnected: false,
  lastTickTime: null,
  ticks: new Map(),
  subscribe: () => {},
  unsubscribe: () => {},
});

export const useMarketSocket = () => useContext(MarketSocketContext);

function subKey(accountId: string, symbol: string) {
  return `${accountId}::${symbol}`;
}

export function MarketSocketProvider({ children }: { children: React.ReactNode }) {
  const { accessToken } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [ticks, setTicks] = useState<Map<string, LiveTick>>(new Map());
  const lastTickTimeRef = useRef<number | null>(null);
  const [lastTickTime, setLastTickTime] = useState<number | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());

  const recordTick = useCallback(() => {
    lastTickTimeRef.current = Date.now();
    setLastTickTime(lastTickTimeRef.current);
  }, []);

  const subscribe = useCallback((accountId: string, symbol: string) => {
    if (!socket || !isConnected) return;
    const key = subKey(accountId, symbol);
    if (!subscribedRef.current.has(key)) {
      socket.emit('subscribe', { accountId, symbol });
      subscribedRef.current.add(key);
    }
  }, [socket, isConnected]);

  const unsubscribe = useCallback((accountId: string, symbol: string) => {
    if (!socket) return;
    const key = subKey(accountId, symbol);
    if (subscribedRef.current.has(key)) {
      socket.emit('unsubscribe', { accountId, symbol });
      subscribedRef.current.delete(key);
    }
  }, [socket]);

  useEffect(() => {
    if (!accessToken) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
        setTicks(new Map());
        subscribedRef.current.clear();
      }
      return;
    }

    const backendBase = (import.meta.env.VITE_BACKEND_URL || '')
      .trim()
      .replace(/\/api$/, '')
      .replace(/\/$/, '');

    const connectionUrl = backendBase || window.location.origin;

    const newSocket = io(`${connectionUrl}/market`, {
      query: { token: accessToken },
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
      console.log('Market websocket connected');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Market websocket disconnected');
    });

    newSocket.on('tick', (data: { accountId: string; symbol: string; tick: Tick }) => {
      recordTick();
      const key = subKey(data.accountId, data.symbol);
      setTicks((prev) => {
        const next = new Map(prev);
        next.set(key, {
          bid: data.tick.bid,
          ask: data.tick.ask,
          last: data.tick.last,
        });
        return next;
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  return (
    <MarketSocketContext.Provider value={{ socket, isConnected, lastTickTime, ticks, subscribe, unsubscribe }}>
      {children}
    </MarketSocketContext.Provider>
  );
}
