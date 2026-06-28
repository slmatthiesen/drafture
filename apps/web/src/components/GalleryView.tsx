/**
 * `/gallery` — the community gallery of operator-approved designs.
 *
 * Fetches the approved list once ($0 DB read) and filters/sorts it in the browser
 * (Phase 2 v1 — server-side filtering arrives only when volume demands it). Each card
 * opens the same `<DesignResult>` renderer via `/design/:id`; visitors can up/down vote
 * (deduped per IP server-side, mirrored locally so the UI reflects the choice).
 *
 * Facets are the 8 deterministic buckets from the API's `pipeline/tags.ts`, mirrored
 * here as plain data (same manual-mirror contract as `lib/types.ts`). A design matches
 * the filter when it carries ANY selected facet (within one facet dimension, OR is the
 * forgiving default); an empty selection shows everything.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchDesigns, voteDesign } from "../lib/api.js";
import type { DesignSummary, TierName } from "../lib/types.js";

// Mirror of `FACETS` in apps/api/src/pipeline/tags.ts (display order). Kept in sync by
// hand for V1, like the schema mirror in lib/types.ts.
const FACETS = [
  "compute",
  "data",
  "messaging",
  "api",
  "realtime",
  "security",
  "robustness",
  "observability",
] as const;

const TIER_LABEL: Record<TierName, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

const VOTE_KEY = "drafture.designs.votes.v1";

type VoteValue = 1 | -1;
type Sort = "score" | "recent";

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

export function GalleryView(): JSX.Element {
  const navigate = useNavigate();
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>("score");
  // Live counts (seeded from the list, updated on each successful vote).
  const [counts, setCounts] = useState<Record<string, { up: number; down: number }>>({});
  const [myVotes, setMyVotes] = useState<Record<string, VoteValue>>(() => loadLocalVotes());
  const [votingId, setVotingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchDesigns().then((list) => {
      if (!live) return;
      setDesigns(list);
      setCounts(
        Object.fromEntries(list.map((d) => [d.id, { up: d.upvotes, down: d.downvotes }])),
      );
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, []);

  const toggleFacet = (facet: string): void => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(facet)) next.delete(facet);
      else next.add(facet);
      return next;
    });
  };

  const visible = useMemo(() => {
    const filtered =
      active.size === 0
        ? designs
        : designs.filter((d) => d.tags.some((t) => active.has(t)));
    const sorted = [...filtered];
    if (sort === "recent") {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      sorted.sort((a, b) => {
        const sa = (counts[a.id]?.up ?? a.upvotes) - (counts[a.id]?.down ?? a.downvotes);
        const sb = (counts[b.id]?.up ?? b.upvotes) - (counts[b.id]?.down ?? b.downvotes);
        return sb - sa || b.createdAt - a.createdAt;
      });
    }
    return sorted;
  }, [designs, active, sort, counts]);

  const castVote = async (id: string, value: VoteValue): Promise<void> => {
    setVotingId(id);
    try {
      const result = await voteDesign(id, value);
      if (!result) return;
      setCounts((prev) => ({ ...prev, [id]: { up: result.upvotes, down: result.downvotes } }));
      setMyVotes((prev) => {
        const next = { ...prev, [id]: value };
        persistLocalVotes(next);
        return next;
      });
    } finally {
      setVotingId(null);
    }
  };

  return (
    <main className="app app--submitted">
      <header className="app__header">
        <span className="app__brand">Drafture</span>
        <div className="app__header-actions">
          <Link className="result__back" to="/">
            ← Back to start
          </Link>
        </div>
        <h1 className="app__goal">
          <span className="app__goal-text">Community gallery</span>
        </h1>
      </header>

      <section className="gallery" aria-label="Community designs">
        <p className="gallery__sub">
          Operator-approved designs from the community — open any one instantly, free.
        </p>

        <div className="gallery__filters" role="group" aria-label="Filter by facet">
          {FACETS.map((facet) => {
            const on = active.has(facet);
            return (
              <button
                key={facet}
                type="button"
                className={`tag-chip ${on ? "tag-chip--on" : ""}`}
                aria-pressed={on}
                onClick={() => toggleFacet(facet)}
              >
                {facet}
              </button>
            );
          })}
        </div>

        <div className="gallery__sortbar">
          <span className="gallery__count">
            {visible.length} {visible.length === 1 ? "design" : "designs"}
          </span>
          <div className="gallery__sort" role="group" aria-label="Sort designs">
            <button
              type="button"
              className={`tag-chip ${sort === "score" ? "tag-chip--on" : ""}`}
              aria-pressed={sort === "score"}
              onClick={() => setSort("score")}
            >
              Top rated
            </button>
            <button
              type="button"
              className={`tag-chip ${sort === "recent" ? "tag-chip--on" : ""}`}
              aria-pressed={sort === "recent"}
              onClick={() => setSort("recent")}
            >
              Newest
            </button>
          </div>
        </div>

        {loading ? (
          <p className="gallery__sub" role="status">
            Loading designs…
          </p>
        ) : visible.length === 0 ? (
          <p className="gallery__sub">
            {designs.length === 0
              ? "No community designs yet — generate one and it'll appear here once approved."
              : "No designs match these facets — clear a filter to see more."}
          </p>
        ) : (
          <ul className="gallery__list">
            {visible.map((d) => {
              const c = counts[d.id] ?? { up: d.upvotes, down: d.downvotes };
              const mine = myVotes[d.id];
              const voting = votingId === d.id;
              return (
                <li key={d.id} className="gallery__item">
                  <button
                    type="button"
                    className="gallery__open"
                    onClick={() => navigate(`/design/${encodeURIComponent(d.id)}`)}
                    title={d.description}
                  >
                    <span className="gallery__name">{d.description}</span>
                    <span className="gallery__tags">
                      <span className="tag-chip tag-chip--tier">
                        {TIER_LABEL[d.recommendedTier] ?? d.recommendedTier}
                      </span>
                      {d.tags.map((t) => (
                        <span key={t} className="tag-chip tag-chip--mini">
                          {t}
                        </span>
                      ))}
                    </span>
                  </button>
                  <span className="gallery__votes" role="group" aria-label={`Rate this design`}>
                    <button
                      type="button"
                      className={`gallery__vote ${mine === 1 ? "gallery__vote--on" : ""}`}
                      aria-label="Upvote design"
                      aria-pressed={mine === 1}
                      disabled={voting}
                      onClick={() => void castVote(d.id, 1)}
                    >
                      ▲ {c.up}
                    </button>
                    <button
                      type="button"
                      className={`gallery__vote ${mine === -1 ? "gallery__vote--on" : ""}`}
                      aria-label="Downvote design"
                      aria-pressed={mine === -1}
                      disabled={voting}
                      onClick={() => void castVote(d.id, -1)}
                    >
                      ▼ {c.down}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
