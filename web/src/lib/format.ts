const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const dtfDate = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});
const nfCurrency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const nfCompact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const TIME_RANGES: {
  limit: number;
  unit: Intl.RelativeTimeFormatUnit;
  divisor: number;
}[] = [
  { limit: 60, unit: 'second', divisor: 1 },
  { limit: 3600, unit: 'minute', divisor: 60 },
  { limit: 86400, unit: 'hour', divisor: 3600 },
  { limit: 604800, unit: 'day', divisor: 86400 },
  { limit: 2629800, unit: 'week', divisor: 604800 },
  { limit: 31557600, unit: 'month', divisor: 2629800 },
  { limit: Number.POSITIVE_INFINITY, unit: 'year', divisor: 31557600 },
];

export function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || !ms || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min < 1) return `${sec}s`;
  return `${min}m ${sec % 60}s`;
}

export function formatCost(value: number | undefined): string {
  if (!Number.isFinite(value)) return nfCurrency.format(0);
  return nfCurrency.format(value ?? 0);
}

export function formatTokens(value: number | undefined): string {
  if (!Number.isFinite(value) || !value) return '0';
  return nfCompact.format(value);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return dtfDate.format(date);
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const deltaSec = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(deltaSec)) return '—';
  const abs = Math.abs(deltaSec);
  for (const { limit, unit, divisor } of TIME_RANGES) {
    if (abs < limit) return rtf.format(Math.round(deltaSec / divisor), unit);
  }
  return '—';
}
