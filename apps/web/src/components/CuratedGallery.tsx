/**
 * "See how it works with these" — the curated example gallery.
 *
 * Server-stored example designs (admin-curated) that open instantly for $0 via the
 * same result view as a fresh generation. Visitors can up/down vote; the server
 * dedupes one vote per IP, and we also remember the local choice so the UI reflects
 * it across reloads and doesn't invite re-clicking.
 */
import { useState } from "react";
import { voteCurated } from "../lib/api.js";
import type { CuratedSummary } from "../lib/types.js";

const VOTE_KEY = "stackdraft.curated.votes.v1";

type VoteValue = 1 | -1;

function loadLocalVotes(): Record<string, VoteValue> {
  try {
    const raw = localStorage.getItem(VOTE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, VoteValue>) : {};
  } catch {
    return {};
  }
}

function persistLocalVotes(votes: Record<string, VoteValue>): void {
  try {
    localStorage.setItem(VOTE_KEY, JSON.stringify(votes));
  } catch {
    /* best-effort */
  }
}

export function CuratedGallery({
  entries,
  onOpen,
}: {
  entries: CuratedSummary[];
  onOpen: (id: string) => void;
}): JSX.Element | null {
  // Live counts (seeded from the server list, updated on each successful vote).
  const [counts, setCounts] = useState<Record<string, { up: number; down: number }>>(() =>
    Object.fromEntries(entries.map((e) => [e.id, { up: e.upvotes, down: e.downvotes }])),
  );
  const [myVotes, setMyVotes] = useState<Record<string, VoteValue>>(() => loadLocalVotes());

  if (entries.length === 0) return null;

  const castVote = async (id: string, value: VoteValue): Promise<void> => {
    const result = await voteCurated(id, value);
    if (!result) return;
    setCounts((prev) => ({ ...prev, [id]: { up: result.upvotes, down: result.downvotes } }));
    setMyVotes((prev) => {
      const next = { ...prev, [id]: value };
      persistLocalVotes(next);
      return next;
    });
  };

  return (
    <section className="gallery" aria-label="Curated example designs">
      <h2 className="gallery__title">See how it works with these</h2>
      <p className="gallery__sub">Real designs we've generated — open one instantly, free.</p>
      <ul className="gallery__list">
        {entries.map((e) => {
          const c = counts[e.id] ?? { up: e.upvotes, down: e.downvotes };
          const mine = myVotes[e.id];
          return (
            <li key={e.id} className="gallery__item">
              <button
                type="button"
                className="gallery__open"
                onClick={() => onOpen(e.id)}
                title={e.prompt}
              >
                <span className="gallery__name">{e.title}</span>
                <span className="gallery__meta">Open · free</span>
              </button>
              <span className="gallery__votes" role="group" aria-label={`Rate ${e.title}`}>
                <button
                  type="button"
                  className={`gallery__vote ${mine === 1 ? "gallery__vote--on" : ""}`}
                  aria-label={`Upvote ${e.title}`}
                  aria-pressed={mine === 1}
                  onClick={() => void castVote(e.id, 1)}
                >
                  ▲ {c.up}
                </button>
                <button
                  type="button"
                  className={`gallery__vote ${mine === -1 ? "gallery__vote--on" : ""}`}
                  aria-label={`Downvote ${e.title}`}
                  aria-pressed={mine === -1}
                  onClick={() => void castVote(e.id, -1)}
                >
                  ▼ {c.down}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
