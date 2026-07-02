/**
 * Shown when the global daily spend ceiling is hit (`daily_budget_reached`) —
 * i.e. Drafture has run out of funds for the day. Surfaced immediately in the
 * page where the result/Terraform would have appeared, so the visitor gets a
 * friendly explanation and a way to reach the operator instead of a dead end.
 *
 * Distinct from the per-visitor daily cap (`daily_cap_reached`), which just means
 * that one visitor used their allotment and others are unaffected.
 */

const REPO_URL = "https://github.com/slmatthiesen/drafture";
const LINKEDIN_URL = "https://www.linkedin.com/in/smatthiesen";

export function BudgetReachedNotice(): JSX.Element {
  return (
    <div className="banner banner--warn budget-out" role="alert">
      <p className="budget-out__text">
        <strong>We're out of tokens for today!</strong> Drafture is a free,
        self-funded demo running on my own Anthropic key. Want to keep going
        right now? It's open source —{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
          clone the project
        </a>
        , add your own Anthropic key, and run it as much as you like. Designs
        you've already opened still work, and generation here resumes tomorrow.
        Or{" "}
        <a href={LINKEDIN_URL} target="_blank" rel="noreferrer noopener">
          message me
        </a>{" "}
        and I'll top it up.
      </p>
    </div>
  );
}
