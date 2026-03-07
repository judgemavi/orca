import { html, parse } from 'diff2html';
import { useEffect, useMemo, useState } from 'react';
import { Button } from './Button';

import 'diff2html/bundles/css/diff2html.min.css';
import { ColorSchemeType } from 'diff2html/lib/types';

function useIsDark() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

interface Props {
  data: {
    taskId: string;
    title: string;
    diff: string;
    filesChanged: string[];
    actions: string[];
  };
  onAction?: (action: string) => void;
}

export function DiffViewer({ data, onAction }: Props) {
  const actions = data?.actions ?? [];
  const [splitView, setSplitView] = useState(false);
  const isDark = useIsDark();

  const files = useMemo(() => parse(data?.diff ?? ''), [data?.diff]);

  const diffHtml = useMemo(
    () =>
      html(data?.diff ?? '', {
        drawFileList: files.length > 1,
        matching: 'lines',
        outputFormat: splitView ? 'side-by-side' : 'line-by-line',
        colorScheme: isDark ? ColorSchemeType.DARK : ColorSchemeType.LIGHT,
      }),
    [data?.diff, splitView, files.length, isDark],
  );

  if (!data?.diff) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{data?.title}</div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <Button
            className="px-2 py-1 text-xs text-muted"
            onClick={() => setSplitView((v) => !v)}
          >
            {splitView ? 'Unified' : 'Split'}
          </Button>
        </div>
      </div>
      <div
        className="overflow-auto rounded-md border border-border"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: diff2html outputs sanitized HTML
        dangerouslySetInnerHTML={{ __html: diffHtml }}
      />
      {actions.length > 0 && (
        <div className="flex justify-end gap-2">
          {actions.map((a) => (
            <Button key={a} variant="default" onClick={() => onAction?.(a)}>
              {a}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
