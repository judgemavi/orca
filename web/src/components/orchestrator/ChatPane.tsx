import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useOrchestratorChat } from '../../hooks/useOrchestratorChat';
import { normalizeToolName } from '../../lib/orchestratorRichContent';
import type { OrchestratorSessionSummary } from '../../types';
import { Button } from '../Button';
import { InlineTaskCard } from './InlineTaskCard';

interface Props {
  className?: string;
}

interface AssistantCodeProps {
  children?: React.ReactNode;
  className?: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function SessionList({
  sessions,
  onSelect,
  onClose,
}: {
  sessions: OrchestratorSessionSummary[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (sessions.length === 0) {
    return (
      <div
        ref={ref}
        className="absolute left-0 right-0 top-full z-50 border-b border-border-subtle bg-surface p-3 shadow-lg"
      >
        <p className="text-xs text-muted">No sessions yet</p>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0 top-full z-50 max-h-64 overflow-y-auto border-b border-border-subtle bg-surface shadow-lg"
    >
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-alt ${s.status === 'active' ? 'bg-surface-alt' : ''}`}
          onClick={() => {
            onSelect(s.id);
            onClose();
          }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {s.status === 'active' ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
              ) : null}
              <span className="truncate text-xs font-medium">
                {s.preview ? truncate(s.preview, 60) : 'Empty session'}
              </span>
            </div>
            <span className="text-[10px] text-muted">
              {s.messageCount} msgs · {formatRelativeTime(s.createdAt)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

const TASK_ID_RE = /^[a-f0-9]{8,64}$/i;
const TOOL_NAME_RE = /^(mcp__orca__)?[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i;
const FILE_REF_RE = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+)?$/;

function asInlineToken(children: React.ReactNode): string {
  if (typeof children === 'string') return children.trim();
  if (Array.isArray(children)) {
    return children
      .map((child) => (typeof child === 'string' ? child : ''))
      .join('')
      .trim();
  }
  return '';
}

export function ChatPane({ className }: Props) {
  const [draft, setDraft] = useState('');
  const [showSessions, setShowSessions] = useState(false);
  const {
    messages,
    sessions,
    isLoadingHistory,
    isStreaming,
    error,
    sendMessage,
    newSession,
    switchSession,
  } = useOrchestratorChat();
  const endRef = useRef<HTMLDivElement>(null);

  const visibleMessages = messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '',
  );

  useEffect(() => {
    if (visibleMessages.length === 0) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [visibleMessages]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft('');
    await sendMessage(text);
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className="relative">
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
            onClick={() => setShowSessions((v) => !v)}
          >
            Orchestrator Chat
            <ChevronDown
              size={12}
              className={showSessions ? 'rotate-180' : ''}
            />
          </button>
          <Button
            className="text-xs"
            onClick={() => void newSession()}
            disabled={isStreaming}
          >
            New Session
          </Button>
        </div>
        {showSessions ? (
          <SessionList
            sessions={sessions}
            onSelect={(id) => void switchSession(id)}
            onClose={() => setShowSessions(false)}
          />
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isLoadingHistory ? (
          <div className="text-xs text-muted">Loading history...</div>
        ) : null}
        <div className="flex flex-col gap-3">
          {visibleMessages.map((message) => {
            if (message.role === 'user') {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-surface-alt px-3 py-2 text-sm whitespace-pre-wrap break-words">
                    {message.content}
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="flex justify-start">
                <div className="max-w-[92%] rounded-lg bg-surface px-3 py-2">
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code: ({ children, className }: AssistantCodeProps) => {
                          const token = asInlineToken(children);
                          if (TASK_ID_RE.test(token)) {
                            return <InlineTaskCard taskId={token} />;
                          }
                          if (TOOL_NAME_RE.test(token)) {
                            return (
                              <span className="rounded bg-surface-alt px-1.5 py-0.5 font-mono text-[11px]">
                                {normalizeToolName(token)}
                              </span>
                            );
                          }
                          if (FILE_REF_RE.test(token)) {
                            return (
                              <code className="rounded bg-surface-alt px-1.5 py-0.5 font-mono text-[11px]">
                                {token}
                              </code>
                            );
                          }
                          return <code className={className}>{children}</code>;
                        },
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          })}

          {isStreaming ? (
            <div className="text-xs text-muted">
              <span className="inline-block animate-pulse">
                Assistant is responding...
              </span>
            </div>
          ) : null}
        </div>
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="border-t border-border-subtle px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      <div className="border-t border-border-subtle px-3 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            className="min-h-20 max-h-56 flex-1 resize-y rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-sm outline-none focus:border-accent"
            placeholder="Ask the orchestrator..."
            disabled={isStreaming}
          />
          <Button
            variant="primary"
            onClick={() => void handleSend()}
            disabled={!draft.trim() || isStreaming}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
