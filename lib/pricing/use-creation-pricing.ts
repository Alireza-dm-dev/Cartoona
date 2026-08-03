"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { CreationPricingCatalog } from "./calculate-creation-cost";

export interface UseCreationPricingResult {
  catalog: CreationPricingCatalog | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

let pendingPromise: Promise<CreationPricingCatalog> | null = null;

function parseCatalog(data: unknown): CreationPricingCatalog {
  if (!data || typeof data !== "object") throw new Error("Invalid response");
  const body = data as { prices?: Record<string, number> };
  if (!body.prices || typeof body.prices !== "object") throw new Error("Invalid response");
  const catalog: Record<string, number> = {};
  for (const [key, value] of Object.entries(body.prices)) {
    if (typeof value !== "number" || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`Invalid price for ${key}`);
    }
    catalog[key] = value;
  }
  if (Object.keys(catalog).length === 0) throw new Error("Empty catalog");
  return catalog as CreationPricingCatalog;
}

async function fetchCatalog(): Promise<CreationPricingCatalog> {
  const res = await fetch(`/api/creation-pricing?_=${Date.now()}`);
  if (!res.ok) throw new Error("CREATION_PRICING_UNAVAILABLE");
  const data = await res.json();
  return parseCatalog(data);
}

function startLoad(
  setCatalog: (v: CreationPricingCatalog | null) => void,
  setLoading: (v: boolean) => void,
  setError: (v: string | null) => void,
  mountedRef: { current: boolean },
) {
  if (!pendingPromise) {
    pendingPromise = fetchCatalog().finally(() => {
      pendingPromise = null;
    });
  }

  pendingPromise
    .then((result) => {
      if (mountedRef.current) {
        setCatalog(result);
        setLoading(false);
      }
    })
    .catch(() => {
      if (mountedRef.current) {
        setError("قیمت‌ها در حال حاضر در دسترس نیستند.");
        setLoading(false);
      }
    });
}

export function useCreationPricing(): UseCreationPricingResult {
  const [catalog, setCatalog] = useState<CreationPricingCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    startLoad(setCatalog, setLoading, setError, mountedRef);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    pendingPromise = null;
    setLoading(true);
    setError(null);
    startLoad(setCatalog, setLoading, setError, mountedRef);
  }, []);

  return { catalog, loading, error, refresh };
}
