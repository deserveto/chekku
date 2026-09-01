'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { AgentIcon } from '@/components/agents/agent-icon';
import type { SocialPostMetadata } from '@chekku/storage';

type StatusFilter = 'all' | 'DRAFT' | 'CANONICAL_APPROVED' | 'APPROVED' | 'PUBLISHED';

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'DRAFT':
      return 'status-draft';
    case 'CANONICAL_APPROVED':
      return 'status-canonical';
    case 'APPROVED':
      return 'status-approved';
    case 'PUBLISHED':
      return 'status-published';
    default:
      return '';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'CANONICAL_APPROVED':
      return 'Canonical';
    default:
      return status.replace('_', ' ');
  }
}

const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function parseSocialPostTimestamp(value: string): number | undefined {
  const match = RFC3339_RE.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', offsetSign, offsetHourText = '0', offsetMinuteText = '0'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]! || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, '0')));
  const offset = (offsetHour * 60 + offsetMinute) * 60_000;
  const timestamp = date.getTime() - (offsetSign === '+' ? offset : offsetSign === '-' ? -offset : 0);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function formatCreatedAt(createdAt: string): string {
  const ts = parseSocialPostTimestamp(createdAt);
  if (ts === undefined) return createdAt;
  return `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export default function SocialPostGrid({ posts }: { posts: SocialPostMetadata[] }) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<StatusFilter>('all');

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: posts.length,
      DRAFT: 0,
      CANONICAL_APPROVED: 0,
      APPROVED: 0,
      PUBLISHED: 0,
    };
    for (const p of posts) {
      if (p.status in c) c[p.status as StatusFilter] += 1;
    }
    return c;
  }, [posts]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return posts.filter((post) => {
      if (activeFilter !== 'all' && post.status !== activeFilter) return false;
      if (!needle) return true;
      return [post.topic, post.postId, post.specialDay ?? '', post.status]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [posts, query, activeFilter]);

  return (
    <div className="studio-registry-section">
      <div className="studio-registry-header">
        <div className="studio-registry-title">
          <h2>
            Saved drafts <span className="studio-registry-count">{posts.length}</span>
          </h2>
          <p className="studio-registry-subtitle">
            Instagram drafts — newest first. Filter by status or search topic and post id.
          </p>
        </div>

        <div className="studio-registry-controls">
          <div role="tablist" aria-label="Filter by status" className="studio-registry-tabs">
            <button
              role="tab"
              type="button"
              aria-selected={activeFilter === 'all'}
              className={activeFilter === 'all' ? 'active' : ''}
              onClick={() => setActiveFilter('all')}
            >
              All <span className="studio-tab-count">{counts.all}</span>
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={activeFilter === 'DRAFT'}
              className={activeFilter === 'DRAFT' ? 'active' : ''}
              onClick={() => setActiveFilter('DRAFT')}
            >
              Draft <span className="studio-tab-count">{counts.DRAFT}</span>
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={activeFilter === 'CANONICAL_APPROVED'}
              className={activeFilter === 'CANONICAL_APPROVED' ? 'active' : ''}
              onClick={() => setActiveFilter('CANONICAL_APPROVED')}
            >
              Canonical <span className="studio-tab-count">{counts.CANONICAL_APPROVED}</span>
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={activeFilter === 'APPROVED'}
              className={activeFilter === 'APPROVED' ? 'active' : ''}
              onClick={() => setActiveFilter('APPROVED')}
            >
              Approved <span className="studio-tab-count">{counts.APPROVED}</span>
            </button>
          </div>

          <label className="studio-search studio-registry-search">
            <span aria-hidden="true" className="studio-search-icon">
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11 L14 14" />
              </svg>
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search topic, id, or status"
              aria-label="Search social posts"
            />
            {query && (
              <button
                type="button"
                className="studio-search-clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                ×
              </button>
            )}
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="studio-empty-state studio-registry-empty">
          <h3>No matching drafts</h3>
          <p>
            {query || activeFilter !== 'all'
              ? 'No drafts match your filters. Clear search or switch tabs.'
              : 'No drafts to show.'}
          </p>
          {(query || activeFilter !== 'all') && (
            <button
              type="button"
              className="studio-button"
              onClick={() => {
                setQuery('');
                setActiveFilter('all');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="studio-social-grid" role="list" aria-label="Saved social posts">
          {filtered.map((post) => (
            <article className="studio-social-card" role="listitem" key={post.postId}>
              <div className="studio-agent-card-top">
                <span className="studio-agent-glyph" aria-hidden="true">
                  <AgentIcon icon="pen" />
                </span>
                <span className={`studio-source-badge ${statusBadgeClass(post.status)}`}>
                  {statusLabel(post.status)}
                </span>
              </div>

              <div className="studio-social-card-body">
                <h3>{post.topic || 'Untitled'}</h3>
                <code>{post.postId}</code>
              </div>

              {post.specialDay ? (
                <p className="studio-social-card-desc">{post.specialDay}</p>
              ) : (
                <p className="studio-social-card-desc">—</p>
              )}

              <dl className="studio-agent-meta">
                <div>
                  <dt>Created</dt>
                  <dd>{formatCreatedAt(post.createdAt)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{statusLabel(post.status)}</dd>
                </div>
              </dl>

              <div className="studio-card-actions">
                <Link
                  className="studio-button studio-button-primary"
                  href={`/social-posts/${encodeURIComponent(post.postId)}`}
                >
                  View post
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
